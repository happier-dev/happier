import { systemTasks } from '@happier-dev/cli-common';

import { runLocalHappierJsonCommand } from './happierCli.js';

export type ActiveRelayProfile = Readonly<{
  serverUrl: string;
  webappUrl: string;
  localServerUrl: string | null;
}>;

export type AuthStatusSnapshot = Readonly<{
  authenticated: boolean;
  machineId: string | null;
}>;

export type DaemonStatusSnapshot = Readonly<{
  serviceInstalled: boolean;
  daemonRunning: boolean;
  needsAuth: boolean;
  machineId: string | null;
}>;

type AuthRequestSnapshot = Readonly<{
  publicKey: string;
}>;

type AuthWaitSnapshot = Readonly<{
  machineId: string | null;
}>;

const DEFAULT_DAEMON_READY_TIMEOUT_MS = 15_000;
const DEFAULT_DAEMON_READY_POLL_MS = 500;

export async function readActiveRelayProfile(): Promise<ActiveRelayProfile> {
  const parsed = await runLocalHappierJsonCommand({ args: ['server', 'current', '--json'] });
  const active = parsed && typeof parsed === 'object'
    ? (parsed as { data?: { active?: Record<string, unknown> } }).data?.active
    : null;

  const serverUrl = typeof active?.serverUrl === 'string' ? active.serverUrl.trim() : '';
  const webappUrl = typeof active?.webappUrl === 'string' && active.webappUrl.trim()
    ? active.webappUrl.trim()
    : serverUrl;
  const localServerUrl = typeof active?.localServerUrl === 'string' && active.localServerUrl.trim()
    ? active.localServerUrl.trim()
    : null;

  if (!serverUrl || !webappUrl) {
    throw new systemTasks.SystemTaskExecutionError(
      'relay_configuration_unavailable',
      'Could not resolve the currently selected Relay configuration.',
    );
  }

  return {
    serverUrl,
    webappUrl,
    localServerUrl,
  };
}

export async function readAuthStatus(): Promise<AuthStatusSnapshot> {
  const parsed = await runLocalHappierJsonCommand({
    args: ['auth', 'status', '--json'],
    allowJsonFailure: true,
  });
  if (!parsed || typeof parsed !== 'object') {
    throw new systemTasks.SystemTaskExecutionError('invalid_cli_response', 'Received an invalid auth status response.');
  }

  const record = parsed as {
    ok?: boolean;
    error?: { code?: unknown };
    data?: {
      authenticated?: unknown;
      machineId?: unknown;
    };
  };

  if (record.ok === false) {
    const errorCode = typeof record.error?.code === 'string' ? record.error.code.trim() : '';
    if (errorCode === 'not_authenticated') {
      return {
        authenticated: false,
        machineId: null,
      };
    }
    throw new systemTasks.SystemTaskExecutionError(
      errorCode || 'auth_status_unavailable',
      'Could not determine authentication status for the selected Relay.',
    );
  }

  return {
    authenticated: record.data?.authenticated === true,
    machineId: typeof record.data?.machineId === 'string' && record.data.machineId.trim()
      ? record.data.machineId.trim()
      : null,
  };
}

export async function configureRelay(profile: ActiveRelayProfile): Promise<void> {
  await runLocalHappierJsonCommand({
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
  });
}

export async function requestAuthPairing(): Promise<AuthRequestSnapshot> {
  const parsed = await runLocalHappierJsonCommand({ args: ['auth', 'request', '--json'] });
  const publicKey = parsed && typeof parsed === 'object' && typeof (parsed as { publicKey?: unknown }).publicKey === 'string'
    ? (parsed as { publicKey: string }).publicKey.trim()
    : '';
  if (!publicKey) {
    throw new systemTasks.SystemTaskExecutionError('invalid_cli_response', 'Received an invalid auth request response.');
  }
  return { publicKey };
}

export async function approveAuthPairing(publicKey: string): Promise<void> {
  await runLocalHappierJsonCommand({
    args: ['auth', 'approve', '--public-key', publicKey, '--json'],
  });
}

export async function waitForAuthPairing(publicKey: string): Promise<AuthWaitSnapshot> {
  const parsed = await runLocalHappierJsonCommand({
    args: ['auth', 'wait', '--public-key', publicKey, '--json'],
  });
  const machineId = parsed && typeof parsed === 'object' && typeof (parsed as { machineId?: unknown }).machineId === 'string'
    ? (parsed as { machineId: string }).machineId.trim()
    : null;
  return { machineId: machineId || null };
}

export async function pairLocalMachineIfNeeded(authStatus: AuthStatusSnapshot): Promise<string | null> {
  if (!authStatus.authenticated) {
    throw new systemTasks.SystemTaskExecutionError(
      'not_authenticated',
      'Authenticate this computer with the selected Relay before continuing.',
    );
  }
  if (authStatus.machineId) {
    return authStatus.machineId;
  }

  const request = await requestAuthPairing();
  await approveAuthPairing(request.publicKey);
  const paired = await waitForAuthPairing(request.publicKey);
  return paired.machineId;
}

export async function installService(): Promise<void> {
  await runLocalHappierJsonCommand({ args: ['daemon', 'service', 'install', '--json'] });
}

export async function startService(): Promise<void> {
  await runLocalHappierJsonCommand({ args: ['daemon', 'service', 'start', '--json'] });
}

export async function readDaemonStatus(): Promise<DaemonStatusSnapshot> {
  const parsed = await runLocalHappierJsonCommand({ args: ['daemon', 'status', '--json'] });
  if (!parsed || typeof parsed !== 'object') {
    throw new systemTasks.SystemTaskExecutionError(
      'invalid_cli_response',
      'Received an invalid daemon status response.',
    );
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
}

export async function waitForReadyDaemon(params: Readonly<{
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
  while ((!latest.serviceInstalled || !latest.daemonRunning || latest.needsAuth) && Date.now() < deadline) {
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
