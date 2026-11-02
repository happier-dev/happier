import { SystemTaskExecutionError } from '../runSystemTask.js';
import type { HappierJsonExecutor } from './happierJsonExecutor.js';
import { scopeHappierJsonExecutor, type HappierServerScope } from './scopeHappierJsonExecutor.js';
import type { LocalServerProfileScope } from './serverScope.js';

import type { EnrollMachineAuthStatus, EnrollMachineDaemonStatus, EnrollMachineRelayProfile, EnrollMachineFlowExecutor } from '../flows/enrollMachineFlow.js';

const DEFAULT_DAEMON_READY_TIMEOUT_MS = 15_000;
const DEFAULT_DAEMON_READY_POLL_MS = 500;

export type EnrollMachineFlowExecutorOptions = Readonly<{
  includeRelayArgsInAuthCommands?: boolean;
  persistAuthCommands?: boolean;
  takeOverManualRelayRuntime?: boolean;
  /**
   * Explicit-Home setup (R10 D3): `configureRelay` saves a Home that has no profile yet without
   * selecting it (`server set --no-use`), and every later command is scoped to the Home's profile
   * (`--server <id>`) and its own service shape, so the terminal's active server and the user's
   * default-following service are never repointed.
   */
  scopeToConfiguredServer?: boolean;
  /**
   * The explicit Home's scope as resolved read-only before any write (`readLocalServerProfileScope`):
   * the exact profile setup addresses, and the one decision of which service serves it.
   * `null`/absent or no `serverId`: the Home had no saved profile yet.
   */
  knownServerScope?: LocalServerProfileScope | null;
}>;

function cliCapabilityMissing(): SystemTaskExecutionError {
  return new SystemTaskExecutionError(
    'cli_capability_missing',
    'The installed Happier CLI is too old to set up this Home without changing your terminal\'s server.',
  );
}

/**
 * Explicit-Home setup must never switch the terminal (R10 D3), but a released 0.2 CLI ignores
 * unknown `server set` flags: `--no-use` would still select the Home. The capability is therefore
 * proven read-only before the first write, from the CLI's own `server help` usage line for
 * `server set`. Anything else — a CLI without that flag, or without that help — is a missing
 * capability, so the caller's replace-and-retry runs and the terminal is never touched.
 */
async function assertServerSetKeepsTerminalSelection(executor: HappierJsonExecutor): Promise<void> {
  const help = await executor.runHappierText(['server', 'help']);
  if (!serverHelpSupportsExplicitHomeSetup(help)) {
    throw cliCapabilityMissing();
  }
}

/**
 * Whether a CLI's `server help` proves it can set up an explicit Home without switching the
 * terminal (`server set … --no-use`). The one capability test for desktop setup: the probe above
 * and the one-CLI question's "can this kept CLI serve setup" (R12) both read it.
 */
export function serverHelpSupportsExplicitHomeSetup(help: Readonly<{ status: number; stdout: string }>): boolean {
  const setUsage = help.status === 0
    ? help.stdout.split(/\r?\n/u).find((line) => /^\s*happier server set\b/u.test(line))
    : undefined;
  return Boolean(setUsage && /(?:^|[\s[])--no-use(?=[\s\]]|$)/u.test(setUsage));
}

function readConfiguredServerScope(parsed: unknown): HappierServerScope {
  const data = parsed && typeof parsed === 'object'
    ? (parsed as { data?: { profile?: { id?: unknown }; used?: unknown } }).data
    : undefined;
  const serverId = typeof data?.profile?.id === 'string' ? data.profile.id.trim() : '';
  // A reply without a saved, unselected profile is a CLI that did not honour `--no-use`.
  if (!serverId || data?.used !== false) {
    throw cliCapabilityMissing();
  }
  // A profile `server set` just created was never selected and has no service of its own, so it
  // gets its own pinned one — which this desktop setup creates, so it is the desktop's (R15).
  return { serverId, targetMode: 'pinned', managedBy: 'desktop' };
}

export function createEnrollMachineFlowExecutorFromHappierJsonExecutor(params: Readonly<{
  executor: HappierJsonExecutor;
  options?: EnrollMachineFlowExecutorOptions;
}>): EnrollMachineFlowExecutor {
  const includeRelayArgsInAuthCommands = params.options?.includeRelayArgsInAuthCommands === true;
  const persistAuthCommands = params.options?.persistAuthCommands === true;
  const takeOverManualRelayRuntime = params.options?.takeOverManualRelayRuntime === true;
  const scopeToConfiguredServer = params.options?.scopeToConfiguredServer === true;
  const knownServerScope = params.options?.knownServerScope ?? null;

  let lastRelayProfile: EnrollMachineRelayProfile | null = null;
  // Every command after `configureRelay` runs through this executor; with explicit-Home scoping it
  // becomes the profile-scoped one once the profile id is known.
  let executor: HappierJsonExecutor = params.executor;

  const buildRelayArgs = (): string[] => {
    if (!includeRelayArgsInAuthCommands || !lastRelayProfile) return [];
    return [
      '--server-url',
      lastRelayProfile.serverUrl,
      ...(lastRelayProfile.localServerUrl ? ['--local-server-url', lastRelayProfile.localServerUrl] : []),
      '--webapp-url',
      lastRelayProfile.webappUrl,
    ];
  };

  const buildPersistArgs = (): string[] => (persistAuthCommands ? ['--persist'] : []);
  const buildServiceTakeoverArgs = (takeover?: boolean): string[] => (
    (takeover ?? takeOverManualRelayRuntime) ? ['--takeover'] : []
  );

  const readDaemonStatus = async (): Promise<EnrollMachineDaemonStatus> => {
    const parsed = await executor.runHappierJson(['daemon', 'status', '--json']);
    if (!parsed || typeof parsed !== 'object') {
      throw new SystemTaskExecutionError('invalid_cli_response', 'Received an invalid daemon status response.');
    }
    const record = parsed as {
      daemon?: { running?: unknown; healthy?: unknown };
      service?: { installed?: unknown };
      auth?: { needsAuth?: unknown; machineId?: unknown };
      server?: { activeServerId?: unknown };
    };
    return {
      serviceInstalled: record.service?.installed === true,
      daemonRunning: record.daemon?.running === true,
      daemonHealthy: typeof record.daemon?.healthy === 'boolean' ? record.daemon.healthy : null,
      needsAuth: record.auth?.needsAuth === true,
      credentialState: readCredentialState(record.auth),
      machineRegistrationState: readMachineRegistrationState(record.auth),
      machineId: typeof record.auth?.machineId === 'string' && record.auth.machineId.trim()
        ? record.auth.machineId.trim()
        : null,
      activeServerId: typeof record.server?.activeServerId === 'string' && record.server.activeServerId.trim()
        ? record.server.activeServerId.trim()
        : null,
    };
  };

  const waitForReadyDaemon: NonNullable<EnrollMachineFlowExecutor['waitForReadyDaemon']> = async (opts) => {
    const timeoutMs = opts.timeoutMs === undefined ? readPositiveIntEnv(
      'HAPPIER_BOOTSTRAP_SETUP_THIS_COMPUTER_SERVICE_READY_TIMEOUT_MS',
      DEFAULT_DAEMON_READY_TIMEOUT_MS,
      { min: 100, max: 120_000 },
    ) : opts.timeoutMs;
    const pollMs = readPositiveIntEnv(
      'HAPPIER_BOOTSTRAP_SETUP_THIS_COMPUTER_SERVICE_READY_POLL_MS',
      DEFAULT_DAEMON_READY_POLL_MS,
      { min: 50, max: 5_000 },
    );

    const deadline = timeoutMs === null ? null : Date.now() + timeoutMs;
    let latest = await readDaemonStatus();

    while (!(opts.signal?.aborted) && (deadline === null || Date.now() < deadline)) {
      if ((opts.requireServiceInstalled === false || latest.serviceInstalled) && latest.daemonRunning && !latest.needsAuth
        && (!opts.requireMachineControlReady || latest.daemonHealthy === true)) {
        return latest;
      }
      await waitForDelay(pollMs, opts.signal);
      latest = await readDaemonStatus();
    }

    opts.signal?.throwIfAborted();
    if (opts.requireMachineControlReady && latest.daemonHealthy !== true) {
      throw new SystemTaskExecutionError('daemon_service_not_ready', 'The background service has not acknowledged its Home machine-control registration.');
    }
    return latest;
  };

  return {
    async configureRelay(profile: EnrollMachineRelayProfile) {
      lastRelayProfile = profile;
      if (scopeToConfiguredServer) {
        await assertServerSetKeepsTerminalSelection(params.executor);
      }
      // A Home whose profile was resolved before the write is used as saved (RV3-C2): the CLI's URL
      // upsert never adopts an identity-bearing profile (it would save a second one beside it), and
      // an endpoint write would replace the Home's recorded canonical URL with the loopback URL the
      // app reaches it on. Setup owns no field of an existing profile; it only saves a new Home.
      if (scopeToConfiguredServer && knownServerScope?.serverId) {
        executor = scopeHappierJsonExecutor(params.executor, {
          serverId: knownServerScope.serverId,
          targetMode: knownServerScope.targetMode,
          managedBy: knownServerScope.managedBy ?? null,
        });
        return;
      }
      const configured = await params.executor.runHappierJson([
        'server',
        'set',
        '--server-url',
        profile.serverUrl,
        ...(profile.localServerUrl ? ['--local-server-url', profile.localServerUrl] : []),
        '--webapp-url',
        profile.webappUrl,
        ...(scopeToConfiguredServer ? ['--no-use'] : []),
        '--json',
      ]);
      if (scopeToConfiguredServer) {
        executor = scopeHappierJsonExecutor(params.executor, readConfiguredServerScope(configured));
      }
    },

    async readAuthStatus(): Promise<EnrollMachineAuthStatus> {
      const parsed = await executor.runHappierJson(['auth', 'status', '--json'], { allowJsonFailure: true });
      if (!parsed || typeof parsed !== 'object') {
        throw new SystemTaskExecutionError('invalid_cli_response', 'Received an invalid auth status response.');
      }

      const record = parsed as {
        ok?: boolean;
        error?: { code?: unknown };
        data?: {
          authenticated?: unknown;
          accountId?: unknown;
          credentialState?: unknown;
          machineRegistered?: unknown;
          machineRegistrationState?: unknown;
          machineId?: unknown;
        };
      };

      if (record.ok === false) {
        const errorCode = typeof record.error?.code === 'string' ? record.error.code.trim() : '';
        if (errorCode === 'not_authenticated') {
          return { authenticated: false, machineId: null };
        }
        throw new SystemTaskExecutionError(
          errorCode || 'auth_status_unavailable',
          'Could not determine authentication status for the selected Relay.',
        );
      }

      return {
        authenticated: record.data?.authenticated === true,
        accountId: typeof record.data?.accountId === 'string' && record.data.accountId.trim()
          ? record.data.accountId.trim()
          : null,
        credentialState: readCredentialState(record.data),
        machineRegistered: record.data?.machineRegistered === true,
        machineRegistrationState: readMachineRegistrationState(record.data),
        machineId: typeof record.data?.machineId === 'string' && record.data.machineId.trim()
          ? record.data.machineId.trim()
          : null,
      };
    },

    async requestAuthPairing() {
      const parsed = await executor.runHappierJson([
        'auth',
        'request',
        '--json',
        ...buildPersistArgs(),
        ...buildRelayArgs(),
      ]);
      if (!parsed || typeof parsed !== 'object') {
        throw new SystemTaskExecutionError('invalid_cli_response', 'Received an invalid auth request response.');
      }
      const publicKey = typeof (parsed as { publicKey?: unknown }).publicKey === 'string'
        ? String((parsed as { publicKey?: string }).publicKey ?? '').trim()
        : '';
      if (!publicKey) {
        throw new SystemTaskExecutionError('invalid_cli_response', 'Received an invalid auth request response.');
      }
      return parsed as Readonly<{ publicKey: string } & Record<string, unknown>>;
    },

    async waitForAuthPairing(publicKey: string) {
      const parsed = await executor.runHappierJson([
        'auth',
        'wait',
        '--public-key',
        publicKey,
        '--json',
        ...buildPersistArgs(),
        ...buildRelayArgs(),
      ]);
      if (!parsed || typeof parsed !== 'object') {
        throw new SystemTaskExecutionError('invalid_cli_response', 'Received an invalid auth wait response.');
      }
      const machineId = typeof (parsed as { machineId?: unknown }).machineId === 'string'
        ? String((parsed as { machineId?: string }).machineId ?? '').trim()
        : '';
      return { machineId: machineId || null };
    },

    async approveAuthPairing(publicKey: string, requestPayload: Readonly<Record<string, unknown>>) {
      await executor.runHappierJson(['auth', 'approve', '--public-key', publicKey, '--request-json-stdin', '--json'], {
        input: JSON.stringify({ publicKey, pairing: requestPayload.pairing, supportsTokenOnly: requestPayload.supportsTokenOnly }),
      });
    },

    async installDaemonService(opts) {
      await executor.runHappierJson([
        'service',
        'install',
        ...buildServiceTakeoverArgs(opts?.takeover),
        // The CLI removes exactly its conflict plan's services for this target (R3-7).
        ...(opts?.replaceExisting ? ['--replace-existing=all', '--yes'] : []),
        ...(opts?.timeoutMs === undefined ? [] : ['--wait-timeout-ms', String(opts.timeoutMs)]),
        '--json',
      ]);
    },

    async startDaemonService(opts) {
      await executor.runHappierJson(['service', 'start', ...buildServiceTakeoverArgs(opts?.takeover),
        ...(opts?.timeoutMs === undefined ? [] : ['--wait-timeout-ms', String(opts.timeoutMs)]), '--json']);
    },

    async restartDaemonService(opts) {
      await executor.runHappierJson(['service', 'restart',
        ...(opts?.timeoutMs === undefined ? [] : ['--wait-timeout-ms', String(opts.timeoutMs)]), '--json']);
    },

    waitForReadyDaemon,
  };
}

function readCredentialState(value: unknown): 'missing' | 'valid' | 'invalid' | 'unknown' | undefined {
  const state = (value as { credentialState?: unknown } | null)?.credentialState;
  return state === 'missing' || state === 'valid' || state === 'invalid' || state === 'unknown'
    ? state
    : undefined;
}

function readMachineRegistrationState(value: unknown): 'no-local-id' | 'local-only' | 'server-confirmed' | undefined {
  const state = (value as { machineRegistrationState?: unknown } | null)?.machineRegistrationState;
  return state === 'no-local-id' || state === 'local-only' || state === 'server-confirmed'
    ? state
    : undefined;
}

function readPositiveIntEnv(
  envVarName: string,
  fallback: number,
  bounds: Readonly<{ min: number; max: number }>,
): number {
  const raw = String(process.env[envVarName] ?? '').trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  const value = Number.isInteger(parsed) ? parsed : fallback;
  if (value < bounds.min) return bounds.min;
  if (value > bounds.max) return bounds.max;
  return value;
}

async function waitForDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise<void>((resolvePromise) => {
    if (signal?.aborted) {
      resolvePromise();
      return;
    }
    let settled = false;
    const cleanupAbortListener = () => signal?.removeEventListener('abort', onAbort);
    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      cleanupAbortListener();
      resolvePromise();
    };
    const timeout = setTimeout(resolveOnce, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      resolveOnce();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
