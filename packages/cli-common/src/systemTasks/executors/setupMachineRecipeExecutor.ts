import { SystemTaskExecutionError } from '../runSystemTask.js';
import type { HappierJsonExecutor } from './happierJsonExecutor.js';

import type {
  SetupMachineAuthStatus,
  SetupMachineDaemonStatus,
  SetupMachineRelayProfile,
  SetupMachineRecipeExecutor,
} from '../recipes/setupMachineRecipe.js';

const DEFAULT_DAEMON_READY_TIMEOUT_MS = 15_000;
const DEFAULT_DAEMON_READY_POLL_MS = 500;

export type SetupMachineRecipeExecutorOptions = Readonly<{
  includeRelayArgsInAuthCommands?: boolean;
  persistAuthCommands?: boolean;
}>;

export function createSetupMachineRecipeExecutorFromHappierJsonExecutor(params: Readonly<{
  executor: HappierJsonExecutor;
  options?: SetupMachineRecipeExecutorOptions;
}>): SetupMachineRecipeExecutor {
  const includeRelayArgsInAuthCommands = params.options?.includeRelayArgsInAuthCommands === true;
  const persistAuthCommands = params.options?.persistAuthCommands === true;

  let lastRelayProfile: SetupMachineRelayProfile | null = null;

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

  const readDaemonStatus = async (): Promise<SetupMachineDaemonStatus> => {
    const parsed = await params.executor.runHappierJson(['daemon', 'status', '--json']);
    if (!parsed || typeof parsed !== 'object') {
      throw new SystemTaskExecutionError('invalid_cli_response', 'Received an invalid daemon status response.');
    }
    const record = parsed as {
      daemon?: { running?: unknown };
      service?: { installed?: unknown };
      auth?: { needsAuth?: unknown; machineId?: unknown };
    };
    return {
      serviceInstalled: record.service?.installed === true,
      daemonRunning: record.daemon?.running === true,
      needsAuth: record.auth?.needsAuth === true,
      machineId: typeof record.auth?.machineId === 'string' && record.auth.machineId.trim()
        ? record.auth.machineId.trim()
        : null,
    };
  };

  const waitForReadyDaemon = async (opts: Readonly<{ signal?: AbortSignal }>): Promise<SetupMachineDaemonStatus> => {
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
    let latest = await readDaemonStatus();

    while (!(opts.signal?.aborted) && Date.now() < deadline) {
      if (latest.serviceInstalled && latest.daemonRunning && !latest.needsAuth) {
        return latest;
      }
      await waitForDelay(pollMs, opts.signal);
      latest = await readDaemonStatus();
    }

    return latest;
  };

  return {
    async configureRelay(profile: SetupMachineRelayProfile) {
      lastRelayProfile = profile;
      await params.executor.runHappierJson([
        'server',
        'set',
        '--server-url',
        profile.serverUrl,
        ...(profile.localServerUrl ? ['--local-server-url', profile.localServerUrl] : []),
        '--webapp-url',
        profile.webappUrl,
        '--json',
      ]);
    },

    async readAuthStatus(): Promise<SetupMachineAuthStatus> {
      const parsed = await params.executor.runHappierJson(['auth', 'status', '--json'], { allowJsonFailure: true });
      if (!parsed || typeof parsed !== 'object') {
        throw new SystemTaskExecutionError('invalid_cli_response', 'Received an invalid auth status response.');
      }

      const record = parsed as {
        ok?: boolean;
        error?: { code?: unknown };
        data?: { authenticated?: unknown; machineId?: unknown };
      };

      if (record.ok === false) {
        const errorCode = typeof record.error?.code === 'string' ? record.error.code.trim() : '';
        if (errorCode === 'not_authenticated') {
          return { authenticated: false, machineId: null };
        }
        throw new SystemTaskExecutionError(
          errorCode || 'auth_status_unavailable',
          'Could not determine authentication status for the selected server.',
        );
      }

      return {
        authenticated: record.data?.authenticated === true,
        machineId: typeof record.data?.machineId === 'string' && record.data.machineId.trim()
          ? record.data.machineId.trim()
          : null,
      };
    },

    async requestAuthPairing() {
      const parsed = await params.executor.runHappierJson([
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
      const parsed = await params.executor.runHappierJson([
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

    async approveAuthPairing(publicKey: string) {
      await params.executor.runHappierJson(['auth', 'approve', '--public-key', publicKey, '--json']);
    },

    async installDaemonService() {
      await params.executor.runHappierJson(['service', 'install', '--json']);
    },

    async startDaemonService() {
      await params.executor.runHappierJson(['service', 'start', '--json']);
    },

    waitForReadyDaemon,
  };
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
