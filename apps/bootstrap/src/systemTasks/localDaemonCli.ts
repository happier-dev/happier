import { resolve as resolvePath } from 'node:path';

import { systemTasks } from '@happier-dev/cli-common';
import {
  formatPinnedDaemonServiceRestartCommand,
  readDesktopInstallationContext,
  planServiceDaemonsRestartAfterCliUpdate,
  resolveManagedCliToolNameForRing,
  STANDARD_MANAGED_CLI_RELEASE_CHANNEL_ENV_KEYS,
  type ServiceDaemonBeforeCliUpdate,
  type ManagedCliUpdateRestart,
} from '@happier-dev/cli-common/firstPartyRuntime';
import { resolveHappyHomeDirFromEnvironment } from '@happier-dev/cli-common/providers';
import { createServerUrlComparableKey, DoctorSnapshotDaemonStatusSchema, type DoctorSnapshotDaemonStatus } from '@happier-dev/protocol';
import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import {
  readLocalHappierCliChoiceFacts,
  resolveLocalHappierCliReleaseRing,
  resolveVersionedLocalHappierCli,
  runLocalHappierJsonCommand,
  type LocalHappierCliChoiceFacts,
  type SetupCapableLocalHappierCli,
} from './happierCli.js';
import type { LocalFirstPartyCommandProvenance } from './localFirstPartyCommand.js';

export type RelayProfileTarget = Readonly<{
  serverUrl: string;
  webappUrl: string;
  localServerUrl: string | null;
}>;

export type ConfiguredRelay = Readonly<{
  serverUrl: string;
  comparableKey: string;
}>;

export type AuthStatusSnapshot = Readonly<{
  authenticated: boolean;
  accountId: string | null;
  /** The label the relay's profile gave the validated account; absent when it gave none. */
  accountLabel?: string | null;
  machineId: string | null;
}>;

export type DaemonCredentialState = 'missing' | 'rejected' | 'valid' | 'unknown';

/**
 * Whether the installed background service follows the default relay or is pinned to one relay
 * profile — the CLI's own vocabulary (`DaemonServiceTargetMode`). A reader that cannot see this
 * cannot tell "a service is installed" apart from "a service this app may repoint on its own".
 */
export type DaemonServiceTargetMode = 'pinned' | 'default-following';

/**
 * Whether the installed background service starts the daemon at login — the CLI's own
 * `DaemonServiceAutostartMode` vocabulary (`apps/cli/src/daemon/service/plan.ts`), not a boolean.
 * A boolean cannot express UNKNOWN, and this seam needs unknown: a CLI that reports no mode must
 * not be read as "off" and taken off the air, nor as "on" and claimed available.
 */
export type DaemonServiceAutostartMode = 'at-login' | 'on-demand';

/**
 * What the running daemon is doing, as the CLI derived it from its authenticated control
 * endpoint and owner evaluation. `null` when the CLI that answered predates the block.
 */
export type DaemonRuntimeConvergence = Readonly<{
  controlReachable: boolean;
  serviceOwnsRunningDaemon: boolean;
  machineIdMatches: boolean;
  cliVersionMatches: boolean;
}>;

/**
 * The ambient inspection. The flat fields are the long-standing summary; the nested blocks
 * carry every fact `happier daemon status --json` emitted, plus which CLI answered.
 */
export type DaemonStatusSnapshot = Readonly<{
  serviceInstalled: boolean;
  daemonRunning: boolean;
  needsAuth: boolean;
  machineId: string | null;
  serverComparableKey: string | null;
  acquisition: Readonly<{
    command: string;
    provenance: LocalFirstPartyCommandProvenance;
    /** The version that CLI reports for itself, so a reader can tell which contract answered. */
    version: string;
    /**
     * The release channel whose managed CLI this is — the default channel's when the app adopted
     * it (D2), else the app's own. `null` for an override CLI, which belongs to no channel.
     */
    channel: PublicReleaseRingId | null;
  }>;
  server: Readonly<{
    activeServerId: string | null;
    serverUrl: string | null;
    publicServerUrl: string | null;
    localServerUrl: string | null;
    comparableKey: string | null;
  }>;
  auth: Readonly<{
    authenticated: boolean;
    machineRegistered: boolean;
    machineId: string | null;
    needsAuth: boolean;
    accountId: string | null;
    credentialState: DaemonCredentialState | null;
    validatedAccountId: string | null;
    /** The validated account's readable name (username, else display name); `null` when unknown. */
    accountLabel: string | null;
  }>;
  service: Readonly<{
    installed: boolean;
    running: boolean;
    /** `null` when nothing proved a mode — an older CLI, or no readable definition. Never a default. */
    targetMode: DaemonServiceTargetMode | null;
    /**
     * The autostart mode the installed definition declares. `null` when the CLI that answered
     * does not report one, so a desktop toggle shows "unknown" instead of claiming the user's
     * computer will stop answering after they close the app.
     */
    autostart: DaemonServiceAutostartMode | null;
  }>;
  daemon: Readonly<{
    running: boolean;
    startedWithCliVersion: string | null;
    serviceManaged: boolean | null;
    serviceLabel: string | null;
  }>;
  runtimeConvergence: DaemonRuntimeConvergence | null;
  cli: Readonly<{
    /**
     * The answering CLI's update state from its cached daily check (plan R17/K1). `managed` says
     * whether this app's install path placed that CLI (`acquisition.provenance`), i.e. whether the
     * app may update it in place (`cli.update.v1`). `null` when the CLI cached no check yet or
     * predates the field.
     */
    update: DaemonCliUpdateState | null;
    /**
     * R12 — this computer's one-CLI answer and the CLI that is not the managed one (the kept CLI,
     * or an old copy still on PATH), with the commands that remove or update it. Read from the
     * app's own records, not the answering CLI, so any CLI version reports it.
     */
    choice: LocalHappierCliChoiceFacts;
  }>;
}>;

export type DaemonCliUpdateState = Readonly<{
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  managed: boolean;
}>;

export type AuthPairingRequest = Readonly<{
  publicKey: string;
  publicKeyB64Url: string;
  pairingRequirement: string;
}>;

export type AuthPairingClaim = Readonly<{
  machineId: string | null;
}>;

/**
 * The structured answer of `happier daemon service install --dry-run --json` (the `service …`
 * alias runs the same command), as bootstrap consumes it. Every ownership/conflict decision stays
 * inside the CLI: bootstrap only reads whether the intended apply would take over a manual daemon
 * or replace competing services (consent), or is blocked outright.
 */
export type ServiceInstallPreview = Readonly<{
  takeover: string | null;
  installConflict: Readonly<{
    blocking: boolean;
    message: string;
    competingServices: readonly string[];
    servicesToRemove: readonly string[];
    /** The installed service runs another CLI and installing switches it to the managed one (K3). */
    runtimeReplacement: Readonly<{ current: string; replacement: string }> | null;
  }> | null;
}>;

export type ServiceInstallApplyFlags = Readonly<{
  replaceExisting: boolean;
  takeover: boolean;
  /** The login-start mode to install with; absent keeps the CLI's own default/current mode. */
  autostart?: DaemonServiceAutostartMode;
}>;

const DEFAULT_DAEMON_READY_TIMEOUT_MS = 15_000;
const DEFAULT_DAEMON_READY_POLL_MS = 500;

/**
 * A resolved CLI and the environment a command spawns it with. Every command this module issues
 * answers for "this computer" under one context rule (plan R13 a): without `processEnv` it runs with
 * the inherited relay selectors cleared (`createSelectedCliInvocation`), so the app's status reads,
 * the service toggle, `cli.update.v1` and a setup run's apply all address this Happier home's
 * persisted selection — the relay setup writes and the background service serves. Only a setup
 * scope's `target` invocation carries an explicit environment.
 */
export type LocalHappierCliInvocation = SetupCapableLocalHappierCli & Readonly<{
  processEnv?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}>;

/**
 * Which of this computer's background services a setup run converges for the app's relay — the
 * CLI's own `DaemonServiceTargetMode` vocabulary:
 *
 * - `default-following` (the released behaviour): `server set` points this Happier home's
 *   persisted selection at the relay, and the one default-following service follows it there;
 * - `pinned` ("connect to this relay too"): the relay gets its own background service, fixed to
 *   it. The persisted selection — and the default-following service serving it — stay untouched,
 *   so this computer answers on both relays (one daemon per relay).
 */
export type SetupServiceTargetMode = DaemonServiceTargetMode;

/**
 * The one execution context of a setup run (plan R13 a), built once from the target relay the app
 * selected and threaded through every command the run issues.
 *
 * A stack/dev launch exports a server selection of its own — `HAPPIER_ACTIVE_SERVER_ID` (the CLI's
 * configuration prefers that persisted profile over a URL it does not match),
 * `HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID` (where daemon state is read) and the URL selectors — so an
 * inherited selector would let a run judge relay Y and then write to relay X. Both invocations
 * clear every one of them:
 *
 * - `target` adds the target through the CLI's env server selection without persisting it, for
 *   the reads that must answer for the target before the run may select it (service-install
 *   dry-run, the target's saved credentials).
 * - `selected` answers for the relay this Happier home's persisted selection names — before
 *   `server set`, the relay the default-following service serves; from `server set` on, the target
 *   — which is exactly what the background service itself reads.
 *
 * A `pinned` run never selects the target, so the two are one invocation: the target through the
 * env server selection, and the service commands addressed to that relay's own pinned service
 * (`HAPPIER_DAEMON_SERVICE_TARGET_MODE`, the key the CLI's service owner reads — and bakes into the
 * definition it installs).
 */
export type SetupCliScope = Readonly<{
  target: LocalHappierCliInvocation;
  selected: LocalHappierCliInvocation;
}>;

const INHERITED_RELAY_SELECTOR_ENV_KEYS = [
  ...STANDARD_MANAGED_CLI_RELEASE_CHANNEL_ENV_KEYS,
  'HAPPIER_SERVER_URL',
  'HAPPIER_WEBAPP_URL',
  'HAPPIER_LOCAL_SERVER_URL',
  'HAPPIER_PUBLIC_SERVER_URL',
  'HAPPIER_ACTIVE_SERVER_ID',
  'HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID',
  // Which installed service a `daemon service …` / `daemon status` command addresses. A stack
  // launch can export its own; inherited, it would point this home's reads and writes at a
  // service the run never chose.
  'HAPPIER_DAEMON_SERVICE_TARGET_MODE',
  'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
  'HAPPIER_DAEMON_SERVICE_SERVER_URL',
  'HAPPIER_DAEMON_SERVICE_WEBAPP_URL',
  'HAPPIER_DAEMON_SERVICE_PUBLIC_SERVER_URL',
  'HAPPIER_DAEMON_SERVICE_CHANNEL',
  'HAPPIER_DAEMON_SERVICE_NODE_PATH',
  'HAPPIER_DAEMON_SERVICE_ENTRY_PATH',
  'HAPPIER_DAEMON_SERVICE_PLATFORM',
  'HAPPIER_DAEMON_SERVICE_UID',
  'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
  'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
  'HAPPIER_DAEMON_SERVICE_MODE',
  'HAPPIER_DAEMON_SERVICE_SYSTEM_USER',
  // Stamps a service definition as the desktop's; only the connect-too install sets it.
  'HAPPIER_DAEMON_SERVICE_MANAGED_BY',
  // R16 — the desktop app a service belongs to; set only on the desktop's own installs.
  'HAPPIER_DAEMON_SERVICE_BUNDLE_ID',
] as const;

function clearInheritedRelaySelectors(processEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const selectedEnv: NodeJS.ProcessEnv = { ...processEnv };
  for (const key of INHERITED_RELAY_SELECTOR_ENV_KEYS) {
    delete selectedEnv[key];
  }
  return selectedEnv;
}

/**
 * The `selected` half of a setup scope on its own: `cli` with every inherited relay selector
 * cleared, so it answers for this Happier home's persisted selection — the relay the background
 * service itself serves. It is also what every invocation without an explicit env runs with.
 */
export function createSelectedCliInvocation(params: Readonly<{
  cli: SetupCapableLocalHappierCli;
  processEnv: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}>): LocalHappierCliInvocation {
  return { ...params.cli, processEnv: clearInheritedRelaySelectors(params.processEnv), ...(params.signal ? { signal: params.signal } : {}) };
}

/**
 * The `target` half's environment on its own: the inherited relay selectors cleared and `target`
 * added through the CLI's env server selection, nothing persisted. For a command that names its
 * relay but lets `runLocalHappierJsonCommand` resolve the CLI (the remote-bootstrap approval).
 */
export function scopeProcessEnvToTargetRelay(target: RelayProfileTarget, processEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...clearInheritedRelaySelectors(processEnv),
    HAPPIER_SERVER_URL: target.serverUrl,
    HAPPIER_WEBAPP_URL: target.webappUrl,
    ...(target.localServerUrl ? { HAPPIER_LOCAL_SERVER_URL: target.localServerUrl } : {}),
  };
}

export function createSetupCliScope(params: Readonly<{
  cli: SetupCapableLocalHappierCli;
  target: RelayProfileTarget;
  processEnv: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Absent means `default-following`, the released behaviour. */
  serviceTargetMode?: SetupServiceTargetMode;
}>): SetupCliScope {
  if (params.serviceTargetMode === 'pinned') {
    const pinned: LocalHappierCliInvocation = {
      ...params.cli,
      processEnv: {
        ...scopeProcessEnvToTargetRelay(params.target, params.processEnv),
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned',
      },
      ...(params.signal ? { signal: params.signal } : {}),
    };
    return { target: pinned, selected: pinned };
  }
  return {
    target: { ...params.cli, processEnv: scopeProcessEnvToTargetRelay(params.target, params.processEnv), ...(params.signal ? { signal: params.signal } : {}) },
    selected: createSelectedCliInvocation(params),
  };
}

/**
 * Runs one JSON command through `invocation`'s CLI and environment — this process's environment
 * with the inherited relay selectors cleared when the invocation names none (one context rule).
 */
async function runInvocationJsonCommand(params: Readonly<{
  args: readonly string[];
  releaseRing: PublicReleaseRingId;
  invocation?: LocalHappierCliInvocation;
  allowJsonFailure?: boolean;
  /** Added on top of the invocation's (or the cleared inherited) env for this one command. */
  extraEnv?: Readonly<Record<string, string>>;
}>): Promise<unknown> {
  const processEnv = { ...(params.invocation?.processEnv ?? clearInheritedRelaySelectors(process.env)), ...(params.extraEnv ?? {}) };
  for (const key of STANDARD_MANAGED_CLI_RELEASE_CHANNEL_ENV_KEYS) delete processEnv[key];
  processEnv.HAPPIER_PUBLIC_RELEASE_CHANNEL = resolveLocalHappierCliReleaseRing({ appRing: params.releaseRing, processEnv });
  return await runLocalHappierJsonCommand({
    args: params.args,
    releaseRing: params.releaseRing,
    ...(params.invocation ? { cli: params.invocation } : {}),
    processEnv,
    signal: params.invocation?.signal,
    ...(params.allowJsonFailure ? { allowJsonFailure: true } : {}),
  });
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * A boolean the CLI's JSON contract has always emitted. Coercing a missing or wrongly typed one to
 * `false` would read corrupt output as "no service, no daemon, no credentials" — the state setup
 * answers by installing and re-pairing — so the value is required rather than defaulted.
 */
function readRequiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new systemTasks.SystemTaskExecutionError(
      'invalid_cli_response',
      `CLI response is missing a boolean "${field}".`,
    );
  }
  return value;
}

export async function readAuthStatus(
  releaseRing: PublicReleaseRingId,
  cli?: LocalHappierCliInvocation,
): Promise<AuthStatusSnapshot> {
  const parsed = await runInvocationJsonCommand({
    args: ['auth', 'status', '--json'],
    releaseRing,
    allowJsonFailure: true,
    invocation: cli,
  });
  if (!parsed || typeof parsed !== 'object') {
    throw new systemTasks.SystemTaskExecutionError('invalid_cli_response', 'Received an invalid auth status response.');
  }

  const record = parsed as {
    ok?: boolean;
    error?: { code?: unknown };
    data?: {
      authenticated?: unknown;
      accountId?: unknown;
      accountLabel?: unknown;
      machineId?: unknown;
    };
  };

  if (record.ok === false) {
    const errorCode = typeof record.error?.code === 'string' ? record.error.code.trim() : '';
    if (errorCode === 'not_authenticated') {
      return {
        authenticated: false,
        accountId: null,
        machineId: null,
      };
    }
    throw new systemTasks.SystemTaskExecutionError(
      errorCode || 'auth_status_unavailable',
      'Could not determine authentication status for the selected Relay.',
    );
  }

  // Not defaulted to "not authenticated": the executor answers that state by requesting a pairing
  // and claiming it with `--replace-existing`, which rewrites credentials and restarts the daemon.
  const authenticated = readRequiredBoolean(record.data?.authenticated, 'data.authenticated');
  const accountId = readNonEmptyString(record.data?.accountId);
  if (authenticated && !accountId) {
    throw new systemTasks.SystemTaskExecutionError(
      'invalid_cli_response',
      'Auth status reported authenticated credentials without the account they belong to.',
    );
  }

  return {
    authenticated,
    accountId,
    accountLabel: readNonEmptyString(record.data?.accountLabel),
    machineId: readNonEmptyString(record.data?.machineId),
  };
}

export async function configureRelay(
  releaseRing: PublicReleaseRingId,
  profile: RelayProfileTarget,
  cli?: LocalHappierCliInvocation,
): Promise<ConfiguredRelay> {
  const parsed = await runInvocationJsonCommand({
    args: [
      'server',
      'set',
      '--server-url',
      profile.serverUrl,
      ...(profile.localServerUrl ? ['--local-server-url', profile.localServerUrl] : []),
      '--webapp-url',
      profile.webappUrl,
      '--json',
    ],
    releaseRing,
    invocation: cli,
  });
  const active = parsed && typeof parsed === 'object'
    ? (parsed as { data?: { active?: { serverUrl?: unknown; comparableKey?: unknown } } }).data?.active
    : undefined;
  const serverUrl = readNonEmptyString(active?.serverUrl);
  const comparableKey = readNonEmptyString(active?.comparableKey);
  if (!serverUrl || !comparableKey) {
    throw new systemTasks.SystemTaskExecutionError('invalid_cli_response', 'Received an invalid server set response.');
  }
  return { serverUrl, comparableKey };
}

export async function requestAuthPairing(
  releaseRing: PublicReleaseRingId,
  cli?: LocalHappierCliInvocation,
): Promise<AuthPairingRequest> {
  const parsed = await runInvocationJsonCommand({ args: ['auth', 'request', '--json'], releaseRing, invocation: cli });
  const record = parsed && typeof parsed === 'object'
    ? (parsed as { publicKey?: unknown; publicKeyB64Url?: unknown; pairingRequirement?: unknown })
    : {};
  const publicKey = readNonEmptyString(record.publicKey);
  const publicKeyB64Url = readNonEmptyString(record.publicKeyB64Url);
  const pairingRequirement = readNonEmptyString(record.pairingRequirement);
  if (!publicKey || !publicKeyB64Url || !pairingRequirement) {
    throw new systemTasks.SystemTaskExecutionError('invalid_cli_response', 'Received an invalid auth request response.');
  }
  return { publicKey, publicKeyB64Url, pairingRequirement };
}

export async function waitForAuthPairing(
  releaseRing: PublicReleaseRingId,
  params: Readonly<{ publicKey: string; replaceExisting: boolean }>,
  cli?: LocalHappierCliInvocation,
): Promise<AuthPairingClaim> {
  let parsed: unknown;
  try {
    parsed = await runInvocationJsonCommand({
      args: [
        'auth',
        'wait',
        '--public-key',
        params.publicKey,
        ...(params.replaceExisting ? ['--replace-existing'] : []),
        '--json',
      ],
      releaseRing,
      invocation: cli,
    });
  } catch (error) {
    if (error instanceof systemTasks.SystemTaskExecutionError && error.code === 'cli_command_timeout') {
      throw new systemTasks.SystemTaskExecutionError(
        'pairing_claim_timeout',
        'The approved pairing was not claimed in time. Run setup again to retry.',
      );
    }
    throw error;
  }
  const machineId = parsed && typeof parsed === 'object'
    ? readNonEmptyString((parsed as { machineId?: unknown }).machineId)
    : null;
  return { machineId };
}

function readServiceLabels(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (entry && typeof entry === 'object' ? readNonEmptyString((entry as { label?: unknown }).label) : null))
    .filter((label): label is string => label !== null);
}

function readRuntimeReplacement(value: unknown): Readonly<{ current: string; replacement: string }> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as { current?: unknown; replacement?: unknown };
  const current = readNonEmptyString(record.current);
  const replacement = readNonEmptyString(record.replacement);
  return current && replacement ? { current, replacement } : null;
}

/**
 * R16 — the one runner of `daemon service install` (the apply, its dry-run and the login-start
 * change): every install the desktop performs names the desktop app (default-following or pinned),
 * so macOS Login Items attributes the service to Happier. The CLI honors the env only on install
 * and keeps it on later rewrites; a terminal install never passes it.
 */
async function runServiceInstallCommand(params: Readonly<{
  args: readonly string[];
  releaseRing: PublicReleaseRingId;
  invocation?: LocalHappierCliInvocation;
  allowJsonFailure?: boolean;
}>): Promise<unknown> {
  const bundleId = readDesktopBundleId(process.env);
  const desktop = readDesktopInstallationContext(process.env);
  return await runInvocationJsonCommand({ ...params,
    args: [...params.args, ...(desktop ? ['--desktop-bundle-id', desktop.bundleId] : [])],
    ...(bundleId ? { extraEnv: { HAPPIER_DAEMON_SERVICE_BUNDLE_ID: bundleId } } : {}),
  });
}

/**
 * The one argv for `daemon service install` — the CLI's idempotent convergence command, which is
 * also how the autostart mode is applied. A second builder would let the two drift in the flags
 * they pass to the same command.
 */
function buildServiceInstallArgs(params: Readonly<{
  flags?: ServiceInstallApplyFlags;
  autostart?: DaemonServiceAutostartMode;
}> = {}): string[] {
  return [
    'daemon',
    'service',
    'install',
    ...(params.flags?.replaceExisting ? ['--yes', '--replace-existing=all'] : []),
    ...(params.flags?.takeover ? ['--takeover'] : []),
    ...((params.autostart ?? params.flags?.autostart) ? [`--autostart=${params.autostart ?? params.flags?.autostart}`] : []),
    '--json',
  ];
}

/**
 * Preview the most complete apply desktop setup may perform (replace competing services, take
 * over a manual daemon). Each of those effects only appears in the response when the CLI would
 * actually perform it, so the response tells the executor exactly what needs consent.
 *
 * Setup previews before `server set` (no mutation before consent), so it passes its scope's
 * `target` invocation: ownership and takeover are per-relay facts, and judging them against the
 * CLI's previous relay would block on a pinned service that does not conflict, or ask to take over
 * a manual daemon the apply can never reach.
 */
export async function previewServiceInstall(
  releaseRing: PublicReleaseRingId,
  cli?: LocalHappierCliInvocation,
): Promise<ServiceInstallPreview> {
  const parsed = await runServiceInstallCommand({
    args: [...buildServiceInstallArgs({ flags: { replaceExisting: true, takeover: true } }), '--dry-run'],
    releaseRing,
    allowJsonFailure: true,
    invocation: cli,
  });
  if (!parsed || typeof parsed !== 'object') {
    throw new systemTasks.SystemTaskExecutionError('invalid_cli_response', 'Received an invalid service install preview.');
  }
  const record = parsed as {
    ok?: unknown;
    error?: unknown;
    message?: unknown;
    plan?: unknown;
    takeover?: unknown;
    installConflict?: {
      blocking?: unknown;
      message?: unknown;
      competingServices?: unknown;
      servicesToRemove?: unknown;
      runtimeReplacement?: unknown;
    } | null;
  };
  if (record.ok === false) {
    throw new systemTasks.SystemTaskExecutionError(
      readNonEmptyString(record.error) ?? 'service_install_blocked',
      readNonEmptyString(record.message) ?? 'The background service cannot be installed on this computer right now.',
    );
  }
  if (!record.plan || typeof record.plan !== 'object') {
    throw new systemTasks.SystemTaskExecutionError('invalid_cli_response', 'Received an invalid service install preview.');
  }

  const conflict = record.installConflict;
  if (conflict !== undefined && conflict !== null) {
    if (typeof conflict !== 'object' || typeof conflict.blocking !== 'boolean' || !readNonEmptyString(conflict.message)) {
      throw new systemTasks.SystemTaskExecutionError('invalid_cli_response', 'Received an invalid service install conflict description.');
    }
  }

  return {
    takeover: readNonEmptyString(record.takeover),
    installConflict: conflict
      ? {
          blocking: conflict.blocking === true,
          message: String(conflict.message).trim(),
          competingServices: readServiceLabels(conflict.competingServices),
          servicesToRemove: readServiceLabels(conflict.servicesToRemove),
          runtimeReplacement: readRuntimeReplacement(conflict.runtimeReplacement),
        }
      : null,
  };
}

export async function installService(
  releaseRing: PublicReleaseRingId,
  flags: ServiceInstallApplyFlags,
  cli?: LocalHappierCliInvocation,
): Promise<void> {
  await runServiceInstallCommand({ args: buildServiceInstallArgs({ flags }), releaseRing, invocation: cli });
}

/**
 * The one invoker of the service lifecycle verbs. `stop` joined `start`/`restart` when desktop
 * gained a background-service toggle: with login start off the app stops the daemon as it quits,
 * and it must stop it through the same command the CLI already owns rather than a second path.
 */
export async function controlDaemonService(
  releaseRing: PublicReleaseRingId,
  params: Readonly<{ action: 'start' | 'stop' | 'restart'; takeover: boolean }>,
  cli?: LocalHappierCliInvocation,
): Promise<void> {
  await runInvocationJsonCommand({
    args: ['daemon', 'service', params.action, ...(params.takeover ? ['--takeover'] : []), '--json'],
    releaseRing,
    invocation: cli,
  });
}

/**
 * The autostart mode of the installed service, expressed through the command that already owns
 * the service definition (`install` is the CLI's idempotent convergence path) and through the
 * flag that command parses. Bootstrap states the intent and re-reads the result; every platform
 * rule stays inside the CLI (INV9).
 */
export async function setDaemonServiceAutostart(
  releaseRing: PublicReleaseRingId,
  autostart: DaemonServiceAutostartMode,
  cli?: LocalHappierCliInvocation,
): Promise<void> {
  await runServiceInstallCommand({
    args: buildServiceInstallArgs({ autostart }),
    releaseRing,
    invocation: cli,
  });
}

/**
 * `happier daemon status --json` prints exactly the doctor snapshot's daemon-status block
 * (`readDaemonStatusSnapshot` is typed from it), so the protocol schema that already owns that
 * wire shape is the parser. One validation, one failure behaviour: corrupt output fails by field
 * name instead of degrading into "no service, no daemon, not authenticated" — the facts that make
 * the app start an installing, re-pairing setup run.
 *
 * Every released 0.2 CLI emits this shape; the fields added since (targetMode, autostart,
 * credentialState, validatedAccountId, runtimeConvergence) are optional in the schema, so an older
 * CLI parses and reports them as unknown.
 */
function parseDaemonStatusResponse(parsed: unknown): DoctorSnapshotDaemonStatus {
  const result = DoctorSnapshotDaemonStatusSchema.safeParse(parsed);
  if (result.success) {
    return result.data;
  }
  const issue = result.error.issues[0];
  const field = issue?.path.join('.') ?? '';
  throw new systemTasks.SystemTaskExecutionError(
    'invalid_cli_response',
    field
      ? `Daemon status response is invalid at "${field}": ${issue?.message ?? 'unexpected value'}.`
      : 'Received an invalid daemon status response.',
  );
}

/**
 * The ambient inspection. `cli` is the CLI a caller already resolved; pass it when the same caller
 * reads status more than once so the acquisition and version read happen once for that run. Like
 * every command here it answers for this home's persisted selection, never a launch's pinned relay,
 * so the app proves ready exactly the relay setup wrote.
 *
 * Absent optional facts are projected to `null` rather than left off: the result crosses to the
 * app, where "the CLI that answered proved no mode" has to be a value a reader can see.
 */
export async function readDaemonStatus(
  releaseRing: PublicReleaseRingId,
  cli?: LocalHappierCliInvocation,
): Promise<DaemonStatusSnapshot> {
  const resolvedCli: LocalHappierCliInvocation = cli ?? await resolveVersionedLocalHappierCli({ releaseRing });
  const desktop = readDesktopInstallationContext(process.env);
  const parsed = await runInvocationJsonCommand({ args: ['daemon', 'status', '--json', ...(desktop ? ['--desktop-bundle-id', desktop.bundleId] : [])], releaseRing, invocation: resolvedCli });
  const status = parseDaemonStatusResponse(parsed);

  return {
    serviceInstalled: status.service.installed,
    daemonRunning: status.daemon.running,
    needsAuth: status.auth.needsAuth,
    machineId: status.auth.machineId,
    serverComparableKey: status.server.comparableKey,
    acquisition: {
      command: resolvedCli.command,
      provenance: resolvedCli.provenance,
      version: resolvedCli.version,
      channel: resolvedCli.provenance === 'managed'
        ? resolveLocalHappierCliReleaseRing({ appRing: releaseRing, processEnv: process.env })
        : null,
    },
    server: {
      activeServerId: status.server.activeServerId,
      serverUrl: status.server.serverUrl,
      publicServerUrl: status.server.publicServerUrl,
      localServerUrl: status.server.localServerUrl,
      comparableKey: status.server.comparableKey,
    },
    auth: {
      authenticated: status.auth.authenticated,
      machineRegistered: status.auth.machineRegistered,
      machineId: status.auth.machineId,
      needsAuth: status.auth.needsAuth,
      accountId: status.auth.accountId,
      credentialState: status.auth.credentialState ?? null,
      validatedAccountId: status.auth.validatedAccountId ?? null,
      accountLabel: status.auth.accountLabel ?? null,
    },
    service: {
      installed: status.service.installed,
      running: status.service.running,
      targetMode: status.service.targetMode ?? null,
      autostart: status.service.autostart ?? null,
    },
    daemon: {
      running: status.daemon.running,
      startedWithCliVersion: status.daemon.startedWithCliVersion ?? null,
      serviceManaged: status.daemon.serviceManaged ?? null,
      serviceLabel: status.daemon.serviceLabel ?? null,
    },
    runtimeConvergence: status.runtimeConvergence ?? null,
    cli: {
      update: status.cliUpdate
        ? { ...status.cliUpdate, managed: resolvedCli.provenance === 'managed' }
        : null,
      choice: readLocalHappierCliChoiceFacts(process.env),
    },
  };
}

/**
 * One installed pinned background service of this Happier home and ring, as the CLI's service
 * inventory (`daemon service list --json`) names it: its instance, the relay profile it pins and
 * the relay URL its definition carries.
 */
export type PinnedDaemonService = Readonly<{
  instanceId: string;
  activeServerId: string;
  relayUrl: string;
  /**
   * `desktop` when the app installed this service ("connect to this relay too"); `null` for any
   * other — a service the user set up (or one from before the marker), which the app shows but
   * never starts, stops or rewrites.
   */
  managedBy: 'desktop' | null;
}>;

function samePath(left: string, right: string): boolean {
  const a = resolvePath(left);
  const b = resolvePath(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

type PinnedDaemonServiceInventory = Readonly<{
  services: readonly PinnedDaemonService[];
  /** The CLI's `pinnedServiceCoexistence` capability: it may run one daemon per relay. */
  coexistence: boolean;
}>;

/**
 * This home's pinned services on `channel`, or `null` when the CLI's answer is not a service
 * inventory at all. Only what is provably this home's is kept: a definition that names another
 * Happier home (a dev stack's, another user's) or none, or another ring's, is not this computer's
 * to report — and a service a reader cannot attribute is never claimed as this app's.
 */
function readPinnedDaemonServiceInventory(parsed: unknown, params: Readonly<{ channel: PublicReleaseRingId; happierHomeDir: string }>): PinnedDaemonServiceInventory | null {
  const record = parsed && typeof parsed === 'object' ? parsed as { entries?: unknown; capabilities?: unknown } : {};
  const entries = record.entries;
  if (!Array.isArray(entries)) {
    return null;
  }
  const capabilities = record.capabilities && typeof record.capabilities === 'object'
    ? record.capabilities as { pinnedServiceCoexistence?: unknown }
    : {};
  const services: PinnedDaemonService[] = [];
  for (const entry of entries) {
    const item = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
    const instanceId = readNonEmptyString(item.serverId);
    const relayUrl = readNonEmptyString(item.relayUrl);
    const homeDir = readNonEmptyString(item.happierHomeDir);
    if (
      item.targetMode !== 'pinned'
      || item.releaseChannel !== params.channel
      || !instanceId
      || !relayUrl
      || !homeDir
      || !samePath(homeDir, params.happierHomeDir)
    ) {
      continue;
    }
    services.push({
      instanceId,
      activeServerId: readNonEmptyString(item.activeServerId) ?? instanceId,
      relayUrl,
      managedBy: item.managedBy === 'desktop' ? 'desktop' : null,
    });
  }
  return { services, coexistence: capabilities.pinnedServiceCoexistence === true };
}

/**
 * `cli` addressed to one pinned service: its relay profile and URL through the CLI's env server
 * selection, and its own service definition through the service target keys — the same keys the
 * CLI bakes into that definition, so `daemon status` answers for exactly the daemon it runs.
 */
function scopeInvocationToPinnedService(cli: LocalHappierCliInvocation, service: PinnedDaemonService): LocalHappierCliInvocation {
  return {
    ...cli,
    processEnv: {
      ...clearInheritedRelaySelectors(cli.processEnv ?? process.env),
      HAPPIER_ACTIVE_SERVER_ID: service.activeServerId,
      HAPPIER_SERVER_URL: service.relayUrl,
      HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned',
      HAPPIER_DAEMON_SERVICE_INSTANCE_ID: service.instanceId,
    },
  };
}

/** `invocation` pinned to one saved CLI server profile: the id its lifecycle, credentials and service use. */
export function pinInvocationToServerProfile(invocation: LocalHappierCliInvocation, profileId: string): LocalHappierCliInvocation {
  return { ...invocation, processEnv: { ...(invocation.processEnv ?? {}), HAPPIER_ACTIVE_SERVER_ID: profileId } };
}

/**
 * `invocation` for the one install that creates a "connect to this relay too" service: the CLI
 * stamps the definition as the desktop's (`managedBy: desktop`), which is what lets the app start,
 * stop and set login start for it — and only it — later.
 */
export function markInstallDesktopManaged(invocation: LocalHappierCliInvocation): LocalHappierCliInvocation {
  return { ...invocation, processEnv: { ...(invocation.processEnv ?? {}), HAPPIER_DAEMON_SERVICE_MANAGED_BY: 'desktop' } };
}

/** The bundle identifier of the desktop app that launched this executor (set by its Tauri shell). */
function readDesktopBundleId(env: NodeJS.ProcessEnv): string | null {
  const value = String(env.HAPPIER_DESKTOP_BUNDLE_ID ?? '').trim();
  return /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(value) ? value : null;
}

/** One pinned service of this home: the invocation addressed to it, and its status or why it has none. */
export type PinnedDaemonServiceRead = Readonly<{
  service: PinnedDaemonService;
  invocation: LocalHappierCliInvocation;
}> & (
  | Readonly<{ status: DaemonStatusSnapshot; error: null }>
  | Readonly<{ status: null; error: Readonly<{ code: string; message: string }> }>
);

/**
 * One daemon per relay: this home's and ring's pinned services, each read through the same
 * `daemon status` owner as the default-following one.
 *
 * Partial, never erased: one unreadable service keeps its place with its error, and `complete` says
 * whether the list is the whole truth — `false` also when the CLI could not list its services at
 * all. A reader never takes an incomplete list for "none". Cancellation is never swallowed.
 */
export type PinnedDaemonServicesSnapshot = Readonly<{
  /** The CLI listed its services; `false` means nothing is known about them. */
  listed: boolean;
  /** Listed, and every listed service's status was read. */
  complete: boolean;
  /** The CLI's `pinnedServiceCoexistence` capability; `false` when it did not say. */
  coexistence: boolean;
  items: readonly PinnedDaemonServiceRead[];
}>;

function readCliError(error: unknown): Readonly<{ code: string; message: string }> {
  const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'status_unavailable';
  return { code, message: error instanceof Error && error.message.trim() ? error.message.trim() : 'The service status could not be read.' };
}

export async function readPinnedDaemonServices(
  releaseRing: PublicReleaseRingId,
  cli: LocalHappierCliInvocation,
): Promise<PinnedDaemonServicesSnapshot> {
  let inventory: PinnedDaemonServiceInventory | null;
  try {
    inventory = readPinnedDaemonServiceInventory(
      await runInvocationJsonCommand({ args: ['daemon', 'service', 'list', '--json'], releaseRing, invocation: cli }),
      {
        channel: resolveLocalHappierCliReleaseRing({ appRing: releaseRing, processEnv: process.env }),
        happierHomeDir: resolveHappyHomeDirFromEnvironment(process.env),
      },
    );
  } catch {
    cli.signal?.throwIfAborted();
    inventory = null;
  }
  if (inventory === null) {
    return { listed: false, complete: false, coexistence: false, items: [] };
  }
  const items = await Promise.all(inventory.services.map(async (service): Promise<PinnedDaemonServiceRead> => {
    const invocation = scopeInvocationToPinnedService(cli, service);
    try {
      return { service, invocation, status: await readDaemonStatus(releaseRing, invocation), error: null };
    } catch (error) {
      cli.signal?.throwIfAborted();
      return { service, invocation, status: null, error: readCliError(error) };
    }
  }));
  return { listed: true, complete: items.every((item) => item.error === null), coexistence: inventory.coexistence, items };
}

/**
 * The pinned services the app manages (`managedBy: desktop`) and may therefore start, stop and set
 * login start for. The app never acts on a service it could not read: an incomplete inventory is
 * reported to the caller, never read as "none".
 */
export async function readAppManagedPinnedServices(
  releaseRing: PublicReleaseRingId,
  cli: LocalHappierCliInvocation,
): Promise<Readonly<{ complete: boolean; unreadable: readonly string[]; services: readonly Readonly<{ invocation: LocalHappierCliInvocation; status: DaemonStatusSnapshot }>[] }>> {
  const snapshot = await readPinnedDaemonServices(releaseRing, cli);
  const services: { invocation: LocalHappierCliInvocation; status: DaemonStatusSnapshot }[] = [];
  const unreadable: string[] = [];
  for (const item of snapshot.items) {
    if (item.service.managedBy !== 'desktop') continue;
    if (item.status) services.push({ invocation: item.invocation, status: item.status });
    else unreadable.push(item.service.relayUrl);
  }
  // Only an inventory the CLI could not give, or a managed service we could not read, is unknown; an
  // unreadable service the user owns is not the app's to act on either way.
  return { complete: snapshot.listed && unreadable.length === 0, unreadable, services };
}

/**
 * What the run's own CLI lists about this home's and ring's pinned services, without reading any
 * status: whether it could list them, whether it may run one daemon per relay
 * (`pinnedServiceCoexistence`), and the relay each listed service is pinned to — readable or not.
 */
export async function readPinnedServiceInventory(
  releaseRing: PublicReleaseRingId,
  cli: LocalHappierCliInvocation,
): Promise<Readonly<{ listed: boolean; coexistence: boolean; relayUrls: readonly string[] }>> {
  let inventory: PinnedDaemonServiceInventory | null;
  try {
    inventory = readPinnedDaemonServiceInventory(
      await runInvocationJsonCommand({ args: ['daemon', 'service', 'list', '--json'], releaseRing, invocation: cli }),
      {
        channel: resolveLocalHappierCliReleaseRing({ appRing: releaseRing, processEnv: process.env }),
        happierHomeDir: resolveHappyHomeDirFromEnvironment(process.env),
      },
    );
  } catch {
    cli.signal?.throwIfAborted();
    inventory = null;
  }
  return inventory
    ? { listed: true, coexistence: inventory.coexistence, relayUrls: inventory.services.map((service) => service.relayUrl) }
    : { listed: false, coexistence: false, relayUrls: [] };
}

/** Whether any of `relayUrls` names one of `targets`, through the canonical comparable key. */
export function relayUrlsOverlap(relayUrls: readonly string[], targets: readonly (string | null)[]): boolean {
  const wanted = new Set(targets.map((url) => (url ? comparableKeyOrNull(url) : null)).filter((key): key is string => key !== null));
  return relayUrls.some((url) => {
    const key = comparableKeyOrNull(url);
    return key !== null && wanted.has(key);
  });
}

/**
 * H3 — removes one pinned service through the CLI's own per-instance uninstall, run addressed to
 * that service (its relay, profile and instance), so the CLI stops that service's own daemon first.
 */
export async function uninstallPinnedService(
  releaseRing: PublicReleaseRingId,
  read: PinnedDaemonServiceRead,
): Promise<void> {
  await runInvocationJsonCommand({
    args: ['daemon', 'service', 'uninstall', '--instance', read.service.instanceId, '--json'],
    releaseRing,
    invocation: read.invocation,
  });
}

/** Whether an installed default-following service or reachable daemon serves this relay. */
export function daemonStatusServesRelay(status: Pick<DaemonStatusSnapshot, 'server' | 'service' | 'runtimeConvergence'>, relayUrl: string): boolean {
  if (!status.service.installed && status.runtimeConvergence?.controlReachable !== true) return false;
  const wanted = comparableKeyOrNull(relayUrl);
  if (wanted === null) return false;
  if (status.server.comparableKey === wanted) return true;
  return [status.server.serverUrl, status.server.publicServerUrl, status.server.localServerUrl]
    .some((url) => url !== null && comparableKeyOrNull(url) === wanted);
}

/** Whether `relayUrl` names the relay `service` is pinned to, through the canonical comparable key. */
export function pinnedServiceServesRelay(service: Pick<PinnedDaemonService, 'relayUrl'>, relayUrl: string): boolean {
  const wanted = comparableKeyOrNull(relayUrl);
  return wanted !== null && comparableKeyOrNull(service.relayUrl) === wanted;
}

/**
 * F1 — the relay's one saved CLI server profile, added (never selected) when the CLI has none for
 * it, so a "connect to this relay too" service is pinned to a stable profile id every CLI `--all`
 * path, the lifecycle lock and a later `server use` of the same URL share. Matched through the
 * canonical comparable key; created through the CLI's own `server add --no-use`.
 */
export async function registerRelayProfile(
  releaseRing: PublicReleaseRingId,
  profile: RelayProfileTarget,
  cli: LocalHappierCliInvocation,
): Promise<Readonly<{ id: string }>> {
  const wanted = new Set([profile.serverUrl, profile.localServerUrl]
    .map((url) => (url ? comparableKeyOrNull(url) : null))
    .filter((key): key is string => key !== null));
  const listed = await runInvocationJsonCommand({ args: ['server', 'list', '--json'], releaseRing, invocation: cli });
  const profiles = (listed as { data?: { profiles?: unknown } } | null)?.data?.profiles;
  if (!Array.isArray(profiles)) {
    throw new systemTasks.SystemTaskExecutionError('invalid_cli_response', 'Received an invalid server list response.');
  }
  for (const entry of profiles) {
    const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
    const id = readNonEmptyString(record.id);
    const keys = [record.comparableKey, record.serverUrl, record.localServerUrl]
      .map((value) => (typeof value === 'string' ? comparableKeyOrNull(value) ?? value : null));
    if (id && keys.some((key) => key !== null && wanted.has(key))) {
      return { id };
    }
  }
  const added = await runInvocationJsonCommand({
    args: [
      'server',
      'add',
      '--name',
      new URL(profile.serverUrl).hostname,
      '--server-url',
      profile.serverUrl,
      ...(profile.localServerUrl ? ['--local-server-url', profile.localServerUrl] : []),
      '--webapp-url',
      profile.webappUrl,
      '--no-use',
      '--json',
    ],
    releaseRing,
    invocation: cli,
  });
  const id = readNonEmptyString((added as { data?: { created?: { id?: unknown } } } | null)?.data?.created?.id);
  if (!id) {
    throw new systemTasks.SystemTaskExecutionError('invalid_cli_response', 'Received an invalid server add response.');
  }
  return { id };
}

export function comparableKeyOrNull(url: string): string | null {
  try {
    return createServerUrlComparableKey(url);
  } catch {
    return null;
  }
}

/**
 * What starting the background service can prove about itself: a service is installed, its daemon
 * answers, and credentials for the configured relay are present.
 *
 * This is deliberately NOT "this computer is ready". Desktop readiness is the CLI-derived
 * `runtimeConvergence` block plus the app's own reachability proof (INV8/INV10) — it also requires
 * that the installed service owns the running daemon, that the machine id and CLI version match,
 * and that the machine answers an RPC. These three flat fields cannot establish any of that, so
 * they are named after the command that produces them and nothing reads them as readiness.
 */
export function isDaemonServiceStarted(status: DaemonStatusSnapshot): boolean {
  return status.serviceInstalled && status.daemonRunning && !status.needsAuth;
}

/** The service command's start prerequisites, shared by its executor and offered row actions. */
export function readDaemonServiceStartFailure(status: Pick<DaemonStatusSnapshot, 'service' | 'auth'>): Readonly<{
  code: 'daemon_service_not_installed' | 'not_authenticated';
  message: string;
}> | null {
  if (!status.service.installed) {
    return { code: 'daemon_service_not_installed', message: 'Daemon service is not installed on this computer yet.' };
  }
  if (status.auth.needsAuth) {
    return { code: 'not_authenticated', message: 'Authenticate this computer with the selected Relay before continuing.' };
  }
  return null;
}

export async function waitForStartedDaemonService(params: Readonly<{
  readDaemonStatus: () => Promise<DaemonStatusSnapshot>;
  signal: AbortSignal;
}>): Promise<DaemonStatusSnapshot> {
  const timeoutMs = readPositiveIntEnv(
    'HAPPIER_BOOTSTRAP_SETUP_THIS_COMPUTER_SERVICE_READY_TIMEOUT_MS',
    DEFAULT_DAEMON_READY_TIMEOUT_MS,
    { min: 100, max: 120_000 },
  );
  const pollMs = readPositiveIntEnv(
    'HAPPIER_BOOTSTRAP_SETUP_THIS_COMPUTER_SERVICE_READY_POLL_MS',
    DEFAULT_DAEMON_READY_POLL_MS,
    { min: 50, max: 5_000 },
  );

  const deadline = Date.now() + timeoutMs;
  let latest = await params.readDaemonStatus();
  while (!isDaemonServiceStarted(latest) && Date.now() < deadline) {
    await delay(pollMs, params.signal);
    latest = await params.readDaemonStatus();
  }
  return latest;
}

function readPositiveIntEnv(
  envVarName: string,
  fallback: number,
  bounds: Readonly<{ min: number; max: number }>,
): number {
  const rawValue = process.env[envVarName];
  const parsed = typeof rawValue === 'string' ? Number.parseInt(rawValue.trim(), 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < bounds.min) {
    return fallback;
  }
  return Math.min(parsed, bounds.max);
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw new systemTasks.SystemTaskExecutionError('cancelled', 'System task execution was cancelled.');
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abortHandler);
      resolve();
    }, ms);
    const abortHandler = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abortHandler);
      reject(new systemTasks.SystemTaskExecutionError('cancelled', 'System task execution was cancelled.'));
    };
    signal.addEventListener('abort', abortHandler, { once: true });
  });
}

/** One service as the CLI reports it before the update, for the shared restart rule. */
function observeService(
  label: string,
  status: DaemonStatusSnapshot,
  invocation: LocalHappierCliInvocation,
  managedBy: 'desktop' | null = null,
  restartCommand?: string,
): ServiceDaemonBeforeCliUpdate<LocalHappierCliInvocation> {
  return {
    label,
    managedBy,
    ...(restartCommand ? { restartCommand } : {}),
    serviceInstalled: status.service.installed,
    daemonRunning: status.daemon.running,
    serviceManaged: status.daemon.serviceManaged === true,
    target: invocation,
  };
}

/** Shared bootstrap service observation and restart proof for explicit and setup-floor updates. */
export async function planLocalHappierCliUpdateRestart(params: Readonly<{
  current: SetupCapableLocalHappierCli;
  releaseRing: PublicReleaseRingId;
  processEnv?: NodeJS.ProcessEnv;
  emit?: (event: unknown) => void;
}>): Promise<ManagedCliUpdateRestart | null> {
  const { current, releaseRing } = params;
  const processEnv = params.processEnv ?? process.env;
  const reportProgress = (message: string) => {
    if (params.emit) params.emit({ type: 'progress', stepId: 'cli.update.restartServices', message });
    else process.stderr.write(`[happier] ${message}\n`);
  };
  const service = createSelectedCliInvocation({ cli: current, processEnv });
  const [status, pinned] = await Promise.all([
    readDaemonStatus(releaseRing, service),
    readPinnedDaemonServices(releaseRing, service),
  ]);
  // M6 — an incomplete inventory is not "no pinned daemons": the relays whose service could
  // not be read (or a list the CLI could not give) are named on the run's own event stream,
  // since those daemons keep the previous CLI until their next restart.
  if (!pinned.complete) {
    const unreadable = pinned.items.filter((item) => item.status === null).map((item) => item.service.relayUrl);
    reportProgress(unreadable.length > 0
        ? `Could not read the background services for ${unreadable.join(', ')}; they keep running the previous version until they restart.`
        : 'Could not list this computer\'s other background services; any of them keeps running the previous version until it restarts.');
  }
  // Which daemons come back is the shared rule `happier self update` uses too.
  return planServiceDaemonsRestartAfterCliUpdate({
    defaultFollowing: observeService('default', status, service),
    // A pinned service whose status could not be read is not known to run a daemon; the
    // desktop update stops no daemon, so it keeps running (and self-restarts on version drift).
    pinned: pinned.items.flatMap((item) => item.status
      ? [observeService(item.service.instanceId, item.status, item.invocation, item.service.managedBy, formatPinnedDaemonServiceRestartCommand({
        // The update runs only on a managed CLI, whose command is its ring's.
        toolName: resolveManagedCliToolNameForRing(resolveLocalHappierCliReleaseRing({ appRing: releaseRing, processEnv })),
        serverId: item.service.activeServerId,
        instanceId: item.service.instanceId,
      }))]
      : []),
    // The update owner checks cancellation before activation. Once activated, its restart
    // and possible restore must settle before reporting cancellation, not race a rollback.
    restartAndProve: async (invocation, expectedVersion) => {
      await controlDaemonService(releaseRing, { action: 'restart', takeover: false }, invocation);
      const restartedStatus = await readDaemonStatus(releaseRing, invocation);
      const runningVersion = restartedStatus.daemon.startedWithCliVersion;
      if (!restartedStatus.daemon.running || runningVersion !== expectedVersion) {
        throw new Error(`the background service runs ${runningVersion ?? 'no daemon'} instead of ${expectedVersion}`);
      }
    },
    // A service the user installed is restarted too, but it never rolls the desktop's update back.
    reportUnownedRestartFailure: reportProgress,
  }).restart;
}
