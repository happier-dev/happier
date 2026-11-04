import { resolveGitHubReleaseToken as resolveBinaryUpdateToken } from '@happier-dev/release-runtime/github';
import { usage } from './self/help';
import chalk from 'chalk';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import packageJson from '../../../package.json';
import { configuration } from '@/configuration';
import type { CommandContext } from '@/cli/commandRegistry';
import {
  FIRST_PARTY_COMPONENT_IDS,
  ManagedCliUpdateError,
  installVersionedPayload,
  prepareFirstPartyComponentPayloadFromGitHubRelease,
  resolveFirstPartyComponentRelease,
  resolveManagedCliReleaseChannelSync,
  resolveManagedCliToolNameForRing,
  resolveInstalledFirstPartyComponentPaths,
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
  normalizePublicReleaseRingId,
  resolvePublicReleaseRingLabelForId,
  type PublicReleaseRingId,
} from '@happier-dev/release-runtime/releaseRings';
import { resolveRunningCliPackageManagerOrigin } from '@/cli/runtime/update/cliUpdateFacts';
import { reportUpdaterAdmission } from '@/cli/runtime/update/updaterAdmission';
import {
  quiesceInstalledCliWindowsPayloadOwners,
  resolvePayloadOwnerStopTimeoutMs,
} from '@/cli/runtime/update/quiesceInstalledCliWindowsPayloadOwners';
import { planServiceDaemonsRestartAfterUpdate } from '@/cli/runtime/update/restartServiceDaemonAfterUpdate';
import { evaluateCurrentDaemonOwner } from '@/daemon/ownership/evaluateCurrentDaemonOwner';
import { resolveCliVersionFromBinary } from '@/daemon/service/resolveCliVersionFromBinary';
import { handleSelfMigrateCommand } from './self/handleSelfMigrateCommand';
import { handleSelfReleaseChannelCommand } from './self/handleSelfReleaseChannelCommand';
import { maybeRunVersionGatedRuntimeMigration } from './self/maybeRunVersionGatedRuntimeMigration';
import { maybeRunDoctorRepair } from './self/maybeRunDoctorRepair';

type SelfChannel = PublicReleaseRingId;




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

export function resolveSelfUpdateCommandForRing(ring: SelfChannel): string {
  return `${resolveManagedCliToolNameForRing(ring)} self update`;
}

function resolveBinaryUpdateRepo(env: NodeJS.ProcessEnv): string {
  const raw = String(env.HAPPIER_GITHUB_REPO ?? '').trim();
  return raw || 'happier-dev/happier';
}


function npmUpgradeCommand(params: Readonly<{ packageName: string; channel: SelfChannel; to: string }>): string {
  const pkg = String(params.packageName ?? '').trim();
  const to = String(params.to ?? '').trim();
  if (to) return `npm install -g ${pkg}@${to}`;
  return `npm install -g ${pkg}@${resolveSelfNpmDistTag(params.channel)}`;
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

function shouldSkipInstallPayloadMigration(processEnv: NodeJS.ProcessEnv): boolean {
  const raw = String(processEnv.HAPPIER_CLI_SKIP_INSTALL_PAYLOAD_MIGRATION ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
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
  const channel = resolveSelfReleaseChannel({ args: argv, rawArgv }).ringId;
  const quiet = argv.includes('--quiet');
  const installSource = detectInstallSource(process.argv[1] ?? '');

  if (installSource === 'binary') {
    // The acquisition owner's own release lookup: the version `self update` would install, on
    // every OS the release publishes (Windows included, plan R13 S-5).
    const { versionId: latest } = await resolveFirstPartyComponentRelease({
      componentId: 'happier-cli',
      channel,
      githubRepo: resolveBinaryUpdateRepo(process.env),
      githubToken: resolveBinaryUpdateToken(process.env),
      userAgent: 'happier-cli',
    });
    const current = configuration.currentCliVersion || null;
    // The one writer of the ring's update-check cache (S-1); another ring's version reads as unknown.
    recordCliUpdateCheck({
      happierHomeDir: configuration.happyHomeDir,
      publicReleaseRing: channel,
      latest,
      current,
      runtimeVersion: null,
      invokerVersion: configuration.currentCliVersion,
    });
    if (quiet) return;
    printCheckResult({ channel, current });
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
    happierHomeDir: configuration.happyHomeDir,
    publicReleaseRing: channel,
    latest: readNpmDistTagVersion({ packageName: pkgName, distTag, cwd: process.cwd(), env: process.env }),
    current,
    runtimeVersion,
    invokerVersion,
  });
  if (quiet) return;
  printCheckResult({ channel, current, unknownMessage: 'Unable to determine latest version (npm view failed).' });
}

function printCheckResult(params: Readonly<{ channel: SelfChannel; current: string | null; unknownMessage?: string }>): void {
  const state = params.current
    ? readCachedCliUpdateState({ happierHomeDir: configuration.happyHomeDir, publicReleaseRing: params.channel, currentVersion: params.current })
    : null;
  if (!state?.latestVersion && params.unknownMessage) {
    console.log(chalk.gray(params.unknownMessage));
    return;
  }
  if (state?.updateAvailable && state.latestVersion) {
    console.log(chalk.yellow(`Update available: ${params.current ?? 'current'} → ${state.latestVersion}`));
    console.log(chalk.gray('Run:'), chalk.cyan(resolveSelfUpdateCommandForRing(params.channel)));
    return;
  }
  console.log(chalk.green('Up to date.'));
}

async function cmdUpdate(argv: string[], rawArgv: readonly string[] = process.argv): Promise<void> {
  const channel = resolveSelfReleaseChannel({ args: argv, rawArgv }).ringId;
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
    console.log(chalk.gray('Run instead:'), chalk.cyan(origin.updateCommand));
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

  // Observed before anything changes: on Windows the update stops the payload's processes, and only
  // this observation still knows which service daemons were running and must come back (S-8). The
  // Windows quiesce stops every server's daemon, so every one of them comes back (R15).
  const serviceRestart = await planServiceDaemonsRestartAfterUpdate({
    channel: effective.channel,
    ownerBeforeUpdate: await evaluateCurrentDaemonOwner(),
    includeOtherServices: process.platform === 'win32',
    processEnv,
  });
  const restartPlan = serviceRestart.plan;

  // The one CLI update transaction (plan R13 f), on every OS the release publishes (S-5).
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
    restartServiceDaemon: serviceRestart.restart,
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
  if (result.restarted && restartPlan.kind === 'restart') {
    console.log(chalk.green(`✓ The background service now runs ${result.targetVersion}`));
  }
  if (restartPlan.kind === 'unmanaged') {
    console.log(chalk.yellow(restartPlan.message));
  }
  const migrationRan = await maybeRunVersionGatedRuntimeMigration({
    fromVersion: result.previousVersion,
    toVersion: result.targetVersion,
    hadLegacyCurrentInstallWithoutVersionMarkers: result.hadLegacyCurrentInstallWithoutVersionMarkers,
    argv: ['repair'],
    commandPath: `${updatedToolName} self migrate`,
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

  // The Windows quiesce stops every service daemon of the payload; each one observed running before
  // it comes back once the payload is promoted (R15). A daemon that does not come back is named and
  // never fails the promotion. Elsewhere nothing is stopped, so nothing is restarted here.
  const quiescedServiceRestart = componentId === 'happier-cli' && process.platform === 'win32'
    ? await planServiceDaemonsRestartAfterUpdate({
      channel,
      ownerBeforeUpdate: await evaluateCurrentDaemonOwner(),
      includeOtherServices: true,
      processEnv: process.env,
    })
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

  if (quiescedServiceRestart?.restart) {
    try {
      await quiescedServiceRestart.restart({ expectedVersion: promotion.currentVersionId, phase: 'activated' });
    } catch (error) {
      process.stderr.write(`The background service did not come back after the update (${error instanceof Error ? error.message : String(error)}). Start it with: ${resolveManagedCliToolNameForRing(channel)} service restart\n`);
    }
  }

  if (componentId === 'happier-cli' && !shouldSkipInstallPayloadMigration(process.env)) {
    const installedPaths = resolveInstalledFirstPartyComponentPaths({
      componentId: 'happier-cli',
      channel,
      processEnv: process.env,
    });
    await maybeRunVersionGatedRuntimeMigration({
      fromVersion: promotion.previousVersionId,
      toVersion: promotion.currentVersionId,
      hadLegacyCurrentInstallWithoutVersionMarkers: promotion.hadLegacyCurrentInstallWithoutVersionMarkers,
      argv: ['repair'],
      installedRuntimeNodePath: installedPaths.binaryPath,
      commandPath: `${resolveManagedCliToolNameForRing(channel)} self migrate`,
    });
  }
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
      await cmdCheck(argv.slice(1), context.rawArgv);
      process.exitCode = 0;
      return;
    }
    if (sub === 'update') {
      await cmdUpdate(argv.slice(1), context.rawArgv);
      process.exitCode = 0;
      return;
    }
    if (sub === '__install-payload') {
      await cmdInternalInstallPayload(argv.slice(1), context.rawArgv);
      process.exitCode = 0;
      return;
    }
    if (sub === 'migrate') {
      await handleSelfMigrateCommand(argv.slice(1));
      process.exitCode = 0;
      return;
    }
    if (sub === 'release-channel') {
      await handleSelfReleaseChannelCommand(argv.slice(1));
      process.exitCode = 0;
      return;
    }
    console.error(fail(`Unknown self subcommand: ${sub}`));
    console.log(usage());
    process.exit(1);
  } catch (error) {
    // A detached updater that ends before admission tells the daemon waiting for it (no-op otherwise).
    reportUpdaterAdmission({
      admitted: false,
      code: error instanceof ManagedCliUpdateError && error.code === 'cli_update_in_progress' ? 'cli_update_in_progress' : 'cli_update_failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
    if (process.env.DEBUG) {
      console.error(error);
    }
    process.exit(1);
  }
}
