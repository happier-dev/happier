import { existsSync } from 'node:fs';

import { systemTasks } from '@happier-dev/cli-common';
import { compareVersions, normalizeSemverBase } from '@happier-dev/cli-common/update';
import { getReleaseRingCatalogEntry, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import {
  describeHappierCliOrigin,
  FirstPartyPayloadMutationLockError,
  ManagedCliUpdateError,
  prepareFirstPartyComponentPayloadFromGitHubRelease,
  readDefaultManagedReleaseChannelSync,
  readHappierCliChoiceSync,
  resolveHappierCliSearchPath,
  runManagedCliUpdate,
  type FirstPartyAcquisitionOptions,
  type HappierCliChoice,
  type ManagedCliUpdateRestart,
} from '@happier-dev/cli-common/firstPartyRuntime';
import type { CliAcquisitionPhase, SetupCliChoicePromptPayload } from '@happier-dev/protocol';

import {
  acquireManagedLocalFirstPartyComponentCommand,
  ensureLocalFirstPartyComponentCommand,
  resolveExplicitOrInstalledLocalFirstPartyCommand,
  resolveForeignLocalHappierCli,
  resolveInstalledLocalFirstPartyCommand,
  resolveTerminalLocalHappierCli,
  toAcquisitionFailure,
  type LocalFirstPartyCommandAcquisitionDeps,
  type ResolvedLocalFirstPartyCommand,
} from './localFirstPartyCommand.js';
import { CommandTimeoutError, parseFirstJsonObject, runCommandCapture } from './taskRuntime.js';
import { planLocalHappierCliUpdateRestart } from './localDaemonCli.js';

const DEFAULT_ENV_VAR_NAMES = [
  'HAPPIER_BOOTSTRAP_CLI_PATH',
  'HAPPIER_BOOTSTRAP_HAPPIER_PATH',
] as const;

/**
 * The oldest Happier CLI release desktop setup can drive. Raise it only when setup starts
 * depending on a newer command contract, and say which one in the commit.
 *
 * 0.2.13: `auth status --json` reports `accountId`; `auth wait --replace-existing` claims a
 * pairing for a different account without resetting credentials.
 *
 * Compared on the semver base only, so a preview or dev build of the same base satisfies it.
 */
export const SETUP_CLI_VERSION_FLOOR = '0.2.13';
// 0.2.13 also scopes daemon start-up reaping and service install conflicts to one relay, which is
// what lets this computer run one daemon per relay ("connect to this relay too"); the status read
// reports pinned services only for a CLI at the floor.


export type SetupCapableLocalHappierCli = ResolvedLocalFirstPartyCommand & Readonly<{
  version: string;
}>;

/**
 * The channel whose CLI drives this computer for an app of `appRing`.
 *
 * One default-following background service exists per `~/.happier`, and it runs the default
 * channel's CLI (`resolveDaemonServiceInstallRuntimeTarget`). An app of another channel adopts it
 * (plan R10 D2): while the default channel's managed CLI is installed, every command the app runs —
 * status, relay, pairing, service install/start — goes through that CLI, so ownership and version
 * checks compare the running daemon with the CLI its service actually runs and the app never
 * installs a competing service or a second CLI. The same holds when this computer's CLI is (or
 * was) one the user installed — any recorded R12 answer (R13 b): a `happier` follows the default
 * channel (its command name is the default channel's, `resolveManagedCliReleaseChannelSync`), so the
 * service it runs is the default channel's, and "Let Happier manage it" replaces it with that
 * channel's managed CLI — the pure runtime switch the answer consents to — instead of making the
 * app's channel the default and leaving the user's service as another ring's to remove. Only a
 * computer with neither uses the app's own channel (and its first install becomes the default).
 */
export function resolveLocalHappierCliReleaseRing(params: Readonly<{
  appRing: PublicReleaseRingId;
  processEnv: NodeJS.ProcessEnv;
}>): PublicReleaseRingId {
  const defaultRing = readDefaultManagedReleaseChannelSync({ processEnv: params.processEnv });
  if (defaultRing === params.appRing) {
    return params.appRing;
  }
  const installed = resolveInstalledLocalFirstPartyCommand({
    componentId: 'happier-cli',
    processEnv: params.processEnv,
    releaseRing: defaultRing,
  });
  if (installed?.provenance === 'managed') {
    return defaultRing;
  }
  return readHappierCliChoiceSync({ processEnv: params.processEnv }) !== null ? defaultRing : params.appRing;
}

function resolveHappierCliParams(params: FirstPartyAcquisitionOptions & Readonly<{
  releaseRing: PublicReleaseRingId;
  processEnv: NodeJS.ProcessEnv;
}>) {
  return {
    componentId: 'happier-cli' as const,
    releaseRing: resolveLocalHappierCliReleaseRing({ appRing: params.releaseRing, processEnv: params.processEnv }),
    processEnv: params.processEnv,
    envVarNames: DEFAULT_ENV_VAR_NAMES,
    signal: params.signal,
    onProgress: params.onProgress,
  };
}

export type LocalHappierJsonCommandParams = Readonly<{
  args: readonly string[];
  releaseRing: PublicReleaseRingId;
  processEnv?: NodeJS.ProcessEnv;
  allowJsonFailure?: boolean;
  signal?: AbortSignal;
  /**
   * A CLI this caller already resolved through one of the resolvers below. Passing it runs the
   * command against exactly that CLI instead of resolving again, so a caller that issues several
   * commands (or polls one) acquires and version-checks once.
   */
  cli?: ResolvedLocalFirstPartyCommand;
}>;

/**
 * Runs a Happier CLI JSON command. Unless the caller passes a CLI it already resolved, every
 * invocation acquires/installs the managed CLI first, so acquisition is part of running a
 * command rather than a separate step a caller can forget.
 */
export async function runLocalHappierJsonCommand(params: LocalHappierJsonCommandParams): Promise<unknown> {
  params.signal?.throwIfAborted();
  const processEnv = params.processEnv ?? process.env;
  const cli = params.cli ?? await ensureLocalFirstPartyComponentCommand(resolveHappierCliParams({
    releaseRing: params.releaseRing,
    processEnv,
    signal: params.signal,
  }));
  const { command } = cli;
  // Service mutations already own OS-command, ownership-wait and recovery budgets. An outer
  // minute can kill a valid Windows ownership wait (120s plus grace), or interrupt recovery.
  const serviceArgs = params.args[0] === 'daemon' ? params.args.slice(1) : params.args;
  const serviceMutation = serviceArgs[0] === 'service'
    && ['install', 'uninstall', 'start', 'stop', 'restart'].includes(serviceArgs[1] ?? '')
    && !params.args.includes('--dry-run');

  const result = await runCommandCapture({
    command,
    args: params.args,
    env: resolveLocalHappierCliEnv(processEnv),
    ...(serviceMutation ? { timeoutMs: 0 } : {}),
    signal: params.signal,
  }).catch((error: unknown) => {
    params.signal?.throwIfAborted();
    if (error instanceof CommandTimeoutError) {
      throw new systemTasks.SystemTaskExecutionError('cli_command_timeout', error.message);
    }
    const message = error instanceof Error && error.message.trim()
      ? error.message.trim()
      : 'Failed to spawn Happier CLI.';
    throw new systemTasks.SystemTaskExecutionError('cli_spawn_failed', message);
  });

  const parsed = parseFirstJsonObject(result.stdout);
  const reportedFailure = readServiceManagerFailure(parsed);

  if (result.status !== 0) {
    if (params.allowJsonFailure && parsed && typeof parsed === 'object') {
      return parsed;
    }
    if (reportedFailure) {
      throw new systemTasks.SystemTaskExecutionError(reportedFailure.code, reportedFailure.message);
    }
    throw new systemTasks.SystemTaskExecutionError(
      'cli_command_failed',
      result.stderr.trim() || result.stdout.trim() || `Command failed: ${command}`,
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new systemTasks.SystemTaskExecutionError(
      'invalid_cli_response',
      `Command did not return a JSON object: ${params.args.join(' ')}`,
    );
  }

  if (!params.allowJsonFailure && isJsonFailureEnvelope(parsed)) {
    if (reportedFailure) {
      throw new systemTasks.SystemTaskExecutionError(reportedFailure.code, reportedFailure.message);
    }
    const envelope = parsed as {
      error?: { code?: unknown; message?: unknown } | unknown;
      message?: unknown;
    };
    const message = typeof envelope.message === 'string' && envelope.message.trim()
      ? envelope.message.trim()
      : envelope.error && typeof envelope.error === 'object' && envelope.error !== null
          && typeof (envelope.error as { message?: unknown }).message === 'string'
        ? ((envelope.error as { message?: string }).message ?? '').trim()
        : `Command failed: ${params.args.join(' ')}`;
    throw new systemTasks.SystemTaskExecutionError('cli_command_failed', message);
  }

  return parsed;
}

/** Preserve the CLI's explicit manager prerequisite failure, without classifying raw output. */
function readServiceManagerFailure(value: unknown) {
  if (!isJsonFailureEnvelope(value)) return null;
  const envelope = value as { error?: unknown; message?: unknown };
  const error = envelope.error;
  const detail = typeof error === 'object' && error !== null
    ? error as { code?: unknown; message?: unknown }
    : null;
  const code = typeof error === 'string' ? error : detail?.code;
  if (code !== 'service_manager_unavailable') return null;
  const message = typeof envelope.message === 'string' ? envelope.message : detail?.message;
  return {
    code,
    message: typeof message === 'string' && message.trim()
      ? message.trim()
      : 'The background service manager is not available on this computer.',
  };
}

/**
 * The environment every Happier CLI command runs with: the caller's, with PATH set to the one a
 * `happier` is looked up in (`resolveHappierCliSearchPath`). On macOS a Dock-launched app has
 * launchd's PATH, so a CLI found through the wider macOS list — an npm `happier` whose
 * `#!/usr/bin/env node` needs Homebrew's `node` — would otherwise fail to start (R12).
 */
function resolveLocalHappierCliEnv(processEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Elsewhere the search path is the process PATH itself (and Windows spells the key `Path`), so
  // the environment is passed through untouched.
  return process.platform === 'darwin' ? { ...processEnv, PATH: resolveHappierCliSearchPath(processEnv) } : processEnv;
}

async function readLocalHappierCliVersion(params: Readonly<{
  command: string;
  processEnv: NodeJS.ProcessEnv;
}>): Promise<string> {
  const result = await runCommandCapture({
    command: params.command,
    args: ['--version'],
    env: resolveLocalHappierCliEnv(params.processEnv),
  }).catch((error: unknown) => {
    const message = error instanceof Error && error.message.trim()
      ? error.message.trim()
      : 'Failed to spawn Happier CLI.';
    throw new systemTasks.SystemTaskExecutionError('cli_spawn_failed', message);
  });
  const version = result.stdout.trim().split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
  if (result.status !== 0 || !normalizeSemverBase(version)) {
    throw new systemTasks.SystemTaskExecutionError(
      'cli_version_unavailable',
      `Could not read the Happier CLI version from ${params.command}: ${result.stderr.trim() || result.stdout.trim() || 'no output'}`,
    );
  }
  return version;
}

/** Whether `version` (base only; an unreadable one never does) is a CLI desktop setup can drive. */
export function meetsSetupVersionFloor(version: string): boolean {
  const base = normalizeSemverBase(version);
  return base !== null && compareVersions(base, SETUP_CLI_VERSION_FLOOR) >= 0;
}

export type LocalHappierCliResolutionOverrides = Partial<LocalFirstPartyCommandAcquisitionDeps & {
  readVersion: typeof readLocalHappierCliVersion;
}>;

/**
 * The Happier CLI already on this computer for a ring, with its version — never acquiring one.
 * `null` when none is installed (or it cannot report a version): for a caller whose question is
 * about what this computer already has, where downloading a CLI would answer nothing (R10-1).
 */
export async function resolveInstalledLocalHappierCli(
  params: Readonly<{ releaseRing: PublicReleaseRingId; processEnv?: NodeJS.ProcessEnv; signal?: AbortSignal }>,
  overrides: LocalHappierCliResolutionOverrides = {},
): Promise<SetupCapableLocalHappierCli | null> {
  const processEnv = params.processEnv ?? process.env;
  const resolved = resolveExplicitOrInstalledLocalFirstPartyCommand(resolveHappierCliParams({ ...params, processEnv }));
  if (!resolved) {
    return null;
  }
  const version = await (overrides.readVersion ?? readLocalHappierCliVersion)({ command: resolved.command, processEnv }).catch(() => null);
  params.signal?.throwIfAborted();
  return version ? { ...resolved, version } : null;
}

/**
 * Resolve the Happier CLI for a ring — installing it when this machine has none — and report which
 * version answered. This is the one place a CLI and its version are established together, so any
 * task that states which CLI served it says so from the CLI's own `--version` output rather than
 * from a second reader.
 */
export async function resolveVersionedLocalHappierCli(
  params: FirstPartyAcquisitionOptions & Readonly<{
    releaseRing: PublicReleaseRingId;
    processEnv?: NodeJS.ProcessEnv;
    assertAcceptableVersion?: (versionId: string) => void;
  }>,
  overrides: LocalHappierCliResolutionOverrides = {},
): Promise<SetupCapableLocalHappierCli> {
  const processEnv = params.processEnv ?? process.env;
  const cliParams = resolveHappierCliParams({ ...params, processEnv });
  const readVersion = overrides.readVersion ?? readLocalHappierCliVersion;
  const resolved = await ensureLocalFirstPartyComponentCommand({ ...cliParams, assertAcceptableVersion: params.assertAcceptableVersion }, overrides);
  params.signal?.throwIfAborted();
  params.onProgress?.({ phase: 'checkingCli' });
  return { ...resolved, version: await readVersion({ command: resolved.command, processEnv }) };
}

/**
 * Resolve a Happier CLI that desktop setup may drive: report its provenance (R13) and enforce
 * the setup version floor. An installed managed CLI below the floor uses the same recoverable
 * update transaction as the explicit Update action; a missing CLI keeps the acquisition path.
 */
export async function ensureSetupCapableLocalHappierCli(
  params: FirstPartyAcquisitionOptions & Readonly<{
    releaseRing: PublicReleaseRingId;
    processEnv?: NodeJS.ProcessEnv;
  }>,
  overrides: LocalHappierCliResolutionOverrides = {},
): Promise<SetupCapableLocalHappierCli> {
  const processEnv = params.processEnv ?? process.env;
  const cliParams = resolveHappierCliParams({ ...params, processEnv });
  const assertAcceptableVersion = (versionId: string) => {
    if (!meetsSetupVersionFloor(versionId)) {
      throw belowSetupFloorError({ releaseRing: cliParams.releaseRing, appRing: params.releaseRing, version: versionId });
    }
  };

  const choice = readHappierCliChoiceSync({ processEnv });
  const keptCommand = choice?.mode === 'own' ? choice.command : null;
  const resolved = await resolveVersionedLocalHappierCli({ ...params, assertAcceptableVersion }, overrides).catch((error: unknown) => {
    // A kept CLI that cannot even report its version cannot drive setup either; it stays the
    // person's to update, so it ends in the same named failure as one below the floor.
    const unresolved = resolveExplicitOrInstalledLocalFirstPartyCommand(cliParams);
    if (keptCommand && unresolved?.command === keptCommand && isCliStartFailure(error)) {
      throw ownCliCannotServeSetupError(keptCommand, null);
    }
    throw error;
  });
  const { version } = resolved;
  if (meetsSetupVersionFloor(version)) {
    return resolved;
  }

  if (keptCommand === resolved.command) {
    // R12 "Keep my own": this CLI is the user's to update, where it came from — never replaced here.
    throw ownCliCannotServeSetupError(resolved.command, version);
  }

  if (resolved.provenance === 'override') {
    throw new systemTasks.SystemTaskExecutionError(
      'cli_override_below_setup_floor',
      `The Happier CLI override at ${resolved.command} is version ${version}, but desktop setup needs ${SETUP_CLI_VERSION_FLOOR} or newer. Update that checkout or remove the override.`,
    );
  }

  const { cli } = await updateManagedLocalHappierCli({
    ...params,
    processEnv,
    assertAcceptableVersion,
    planRestart: (current) => planLocalHappierCliUpdateRestart({ current, releaseRing: params.releaseRing, processEnv }),
  }, overrides);
  return cli;
}

/** A `happier` this app did not install, named with the commands that remove or update it (R12). */
export type LocalOtherHappierCli = Readonly<{
  command: string;
  origin: SetupCliChoicePromptPayload['origin'];
  removalCommand: string | null;
  updateCommand: string | null;
}>;

/**
 * R12 — this computer's CLI choice as the app shows it: `mode` is the recorded answer (`null`:
 * nobody was asked), and `otherCli` the CLI that is not the managed one — the kept CLI after "Keep
 * my own", otherwise a `happier` still on the search path (the old copy after "Let Happier manage
 * it"). A kept CLI that disappeared stays the answer (R13 b); a `happier` installed since elsewhere
 * is then the one there is to choose, and with none the kept path is still named. No process is
 * spawned.
 */
export type LocalHappierCliChoiceFacts = Readonly<{
  mode: HappierCliChoice['mode'] | null;
  otherCli: LocalOtherHappierCli | null;
}>;

export function readLocalHappierCliChoiceFacts(processEnv: NodeJS.ProcessEnv = process.env): LocalHappierCliChoiceFacts {
  const choice = readHappierCliChoiceSync({ processEnv });
  const keptCommand = choice?.mode === 'own' ? choice.command : null;
  const command = keptCommand && existsSync(keptCommand)
    ? keptCommand
    : resolveForeignLocalHappierCli(processEnv) ?? keptCommand;
  if (!command) {
    return { mode: choice?.mode ?? null, otherCli: null };
  }
  const origin = describeHappierCliOrigin(command);
  return {
    mode: choice?.mode ?? null,
    otherCli: { command, origin: origin.kind, removalCommand: origin.removalCommand, updateCommand: origin.updateCommand },
  };
}

export type LocalHappierCliChoiceInspection = Readonly<{
  /** What this computer recorded, including a kept CLI that has since disappeared. */
  choice: HappierCliChoice | null;
  /** The one question to ask before setup writes anything, or `null` when there is none. */
  question: SetupCliChoicePromptPayload | null;
}>;

/**
 * R12 — whether setup must ask "Let Happier manage it / Keep my own" before it writes anything,
 * and about which CLI. Read-only: it runs only that CLI's `--version`.
 *
 * Asked when the `happier` a new terminal runs first is one this app did not install and nobody
 * answered yet (RV3-1: a copy further down, behind the managed CLI, is Settings' to name, not a
 * question — the terminal already runs the managed CLI), when the kept
 * CLI is below the setup floor (keeping it cannot finish setup), and when the kept CLI disappeared
 * (R13 b) — about a `happier` installed since elsewhere, or else about the missing one by its path,
 * so nothing is acquired in its place unasked. `reconsider` is Settings' change action, which asks
 * again about whichever CLI there is to choose. A developer override (`HAPPIER_BOOTSTRAP_CLI_PATH`)
 * is never asked about, and a computer with no other CLI keeps the managed default with no question.
 */
export async function inspectLocalHappierCliChoice(
  params: Readonly<{ processEnv?: NodeJS.ProcessEnv; reconsider?: boolean }>,
  overrides: Readonly<{ readVersion?: typeof readLocalHappierCliVersion }> = {},
): Promise<LocalHappierCliChoiceInspection> {
  const processEnv = params.processEnv ?? process.env;
  const readVersion = overrides.readVersion ?? readLocalHappierCliVersion;
  const choice = readHappierCliChoiceSync({ processEnv });
  if (DEFAULT_ENV_VAR_NAMES.some((name) => String(processEnv[name] ?? '').trim())) {
    return { choice, question: null };
  }

  const other = readLocalHappierCliChoiceFacts(processEnv).otherCli;
  if (!other || (choice?.mode === 'managed' && !params.reconsider)) {
    return { choice, question: null };
  }
  const terminal = resolveTerminalLocalHappierCli(processEnv);
  if (choice === null && !params.reconsider && !(terminal && !terminal.managed)) {
    return { choice, question: null };
  }
  // Keeping `other` makes the terminal run it only when what answers first is `other` itself or a
  // managed CLI Desktop exposed (and "Keep my own" takes back). The installer's link keeps answering.
  const keepBlockedBy = terminal?.managed && !terminal.desktopExposed ? terminal.command : null;
  const missing = !existsSync(other.command);
  const version = missing ? null : await readVersion({ command: other.command, processEnv }).catch(() => null);
  // A CLI that cannot report its version cannot drive setup either.
  const belowSetupFloor = version === null || !meetsSetupVersionFloor(version);
  const keptAndUsable = choice?.mode === 'own' && choice.command === other.command && !missing && !belowSetupFloor;
  if (keptAndUsable && !params.reconsider) {
    return { choice, question: null };
  }
  return { choice, question: { ...other, version, belowSetupFloor, missing, keepBlockedBy } };
}

function isCliStartFailure(error: unknown): boolean {
  return error instanceof systemTasks.SystemTaskExecutionError
    && (error.code === 'cli_version_unavailable' || error.code === 'cli_spawn_failed');
}

/** `cli_own_below_setup_floor`, naming the update command that CLI's origin proves (R12). */
function ownCliCannotServeSetupError(command: string, version: string | null): systemTasks.SystemTaskExecutionError {
  const { updateCommand } = describeHappierCliOrigin(command);
  const found = version
    ? `Your Happier CLI at ${command} is version ${version}, but desktop setup needs ${SETUP_CLI_VERSION_FLOOR} or newer.`
    : `Your Happier CLI at ${command} did not report a version, so desktop setup cannot use it (it needs ${SETUP_CLI_VERSION_FLOOR} or newer).`;
  return new systemTasks.SystemTaskExecutionError(
    'cli_own_below_setup_floor',
    updateCommand ? `${found} Update it with: ${updateCommand}` : `${found} Update it where you installed it.`,
  );
}

/**
 * R12 — the ambient read failed on the CLI the one-CLI question is about: a `happier` nobody has
 * answered for yet, or the one the person kept. Retrying the read cannot change that, so the
 * failure is named `cli_choice_required` and the app's entry policy routes it into setup, whose
 * first step asks the question (a kept CLI that cannot report its version counts as below the
 * floor there). `null` for any other failure, a cancelled read, or a developer override.
 */
export function describeUnservedCliChoiceFailure(
  error: unknown,
  params: Readonly<{ releaseRing: PublicReleaseRingId; processEnv?: NodeJS.ProcessEnv }>,
): systemTasks.SystemTaskExecutionError | null {
  const processEnv = params.processEnv ?? process.env;
  if (!(error instanceof systemTasks.SystemTaskExecutionError) || error.code === 'cancelled') {
    return null;
  }
  if (error.code === 'cli_choice_required') {
    // Already named — the resolver's answer for a kept CLI that disappeared (R13 b).
    return error;
  }
  if (DEFAULT_ENV_VAR_NAMES.some((name) => String(processEnv[name] ?? '').trim())) {
    return null;
  }
  const facts = readLocalHappierCliChoiceFacts(processEnv);
  const other = facts.mode === 'managed' ? null : facts.otherCli;
  const answering = resolveExplicitOrInstalledLocalFirstPartyCommand(resolveHappierCliParams({ releaseRing: params.releaseRing, processEnv }));
  if (!other || answering?.command !== other.command) {
    return null;
  }
  return new systemTasks.SystemTaskExecutionError(
    'cli_choice_required',
    `The Happier CLI at ${other.command} could not answer (${error.code}): ${error.message}`,
  );
}

/**
 * Update the desktop-managed CLI in place (plan R17/K2) through the one CLI update transaction
 * (`runManagedCliUpdate`, plan R13 f) — the same one `happier self update` runs: one verified
 * download of one target version, a smoke of the staged binary, activation under the install lock
 * without pruning, the service restart `planRestart` returns (when this computer's service daemon
 * runs), then commit — or a full restore and a restart of the previous version. A CLI this app did
 * not install is refused by name: it is updated where it came from, not replaced.
 */
export async function updateManagedLocalHappierCli(
  params: FirstPartyAcquisitionOptions & Readonly<{
    releaseRing: PublicReleaseRingId;
    processEnv?: NodeJS.ProcessEnv;
    /** The proven restart of the service daemon for this CLI, or `null` when its daemon is not running. */
    planRestart: (current: SetupCapableLocalHappierCli) => Promise<ManagedCliUpdateRestart | null>;
    assertAcceptableVersion?: (versionId: string) => void;
  }>,
  overrides: LocalHappierCliResolutionOverrides = {},
): Promise<Readonly<{ previousVersion: string; cli: SetupCapableLocalHappierCli; restarted: boolean }>> {
  const processEnv = params.processEnv ?? process.env;
  const cliParams = resolveHappierCliParams({ ...params, processEnv });
  const readVersion = overrides.readVersion ?? readLocalHappierCliVersion;
  const preparePayload = overrides.preparePayload ?? prepareFirstPartyComponentPayloadFromGitHubRelease;

  const current = await resolveVersionedLocalHappierCli(params, overrides);
  if (current.provenance !== 'managed') {
    throw new systemTasks.SystemTaskExecutionError(
      'cli_not_managed',
      `The Happier CLI at ${current.command} was not installed by Happier, so it is not updated here. Update it where it came from.`,
    );
  }
  const restartServiceDaemon = await params.planRestart(current);

  let phase: CliAcquisitionPhase = 'resolvingRelease';
  const onProgress: NonNullable<FirstPartyAcquisitionOptions['onProgress']> = (progress) => {
    phase = progress.phase;
    if (!params.signal?.aborted) params.onProgress?.(progress);
  };
  const result = await runManagedCliUpdate({
    channel: cliParams.releaseRing,
    processEnv,
    signal: params.signal,
    onProgress,
    preparePayload: async (prepareParams) => {
      const prepared = await preparePayload(prepareParams);
      try {
        params.assertAcceptableVersion?.(prepared.versionId);
        return prepared;
      } catch (error) {
        await prepared.cleanup();
        throw error;
      }
    },
    readVersion: async (command) => await readVersion({ command, processEnv }).catch(() => null),
    restartServiceDaemon,
  }).catch((error: unknown) => {
    params.signal?.throwIfAborted();
    if (error instanceof ManagedCliUpdateError) {
      throw new systemTasks.SystemTaskExecutionError(error.code, error.message);
    }
    if (error instanceof FirstPartyPayloadMutationLockError) {
      throw new systemTasks.SystemTaskExecutionError('cli_update_in_progress', error.message);
    }
    throw toAcquisitionFailure({ componentId: 'happier-cli', error, phase, onProgress });
  });
  if (result.outcome === 'rolledBack') {
    throw new systemTasks.SystemTaskExecutionError('cli_update_rolled_back', result.message);
  }
  if (result.outcome === 'failed') {
    throw new systemTasks.SystemTaskExecutionError('cli_update_failed', result.message);
  }
  return {
    previousVersion: current.version,
    cli: { ...current, version: result.targetVersion },
    restarted: result.restarted,
  };
}

/**
 * The ring's newest CLI cannot satisfy the floor. When that ring is the default channel this app
 * adopted (D2) rather than its own, updating the app changes nothing: the failure is its own code
 * (`cli_default_channel_below_setup_floor`) and names the default channel, its newest version, the
 * app's channel and the two ways out, in the installer's channel vocabulary.
 */
function belowSetupFloorError(params: Readonly<{
  /** The ring whose CLI drives this computer (`resolveLocalHappierCliReleaseRing`). */
  releaseRing: PublicReleaseRingId;
  /** The app's own ring. */
  appRing: PublicReleaseRingId;
  version: string;
}>): systemTasks.SystemTaskExecutionError {
  if (params.releaseRing !== params.appRing) {
    const channel = getReleaseRingCatalogEntry(params.releaseRing).publicLabel;
    const appChannel = getReleaseRingCatalogEntry(params.appRing).publicLabel;
    return new systemTasks.SystemTaskExecutionError(
      'cli_default_channel_below_setup_floor',
      `This computer's Happier command line follows its default channel, ${channel}, whose newest CLI is ${params.version}; desktop setup needs ${SETUP_CLI_VERSION_FLOOR} or newer. Wait for the next ${channel} CLI release, or make ${appChannel} this computer's default channel with the Happier installer (--channel ${appChannel}).`,
    );
  }
  return new systemTasks.SystemTaskExecutionError(
    'cli_below_setup_floor',
    `The newest Happier CLI on the ${params.releaseRing} ring is ${params.version}, but desktop setup needs ${SETUP_CLI_VERSION_FLOOR} or newer. Update the app or wait for the next CLI release.`,
  );
}

function isJsonFailureEnvelope(value: unknown): value is Readonly<{ ok: false }> {
  return Boolean(
    value
      && typeof value === 'object'
      && 'ok' in value
      && (value as { ok?: unknown }).ok === false,
  );
}
