import { SystemTaskExecutionError } from '../runSystemTask.js';
import type { SetupMachineRecipeExecutor } from '../recipes/setupMachineRecipe.js';
import type {
  RemoteBootstrapMachineParams,
  RemoteSshAuth,
  RemoteSshBootstrapHappierJsonExecutor,
  RemoteSshBootstrapMachineDeps,
} from '../kinds/remoteSshBootstrapMachineKind.js';

import { createRemoteSshBootstrapHappierJsonExecutor } from './remoteSshBootstrapHappierJsonExecutor.js';
import { createSetupMachineRecipeExecutorFromHappierJsonExecutor } from './setupMachineRecipeExecutor.js';
import type { HappierJsonExecutor } from './happierJsonExecutor.js';

type RemoteCommandResult = Awaited<ReturnType<RemoteSshBootstrapHappierJsonExecutor['runHappierJson']>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** When inspecting a failed process, only the CLI's expected signed-out exit is admissible. */
export function isRemoteBootstrapUnauthenticatedCliResult(value: unknown, exitStatus?: number): boolean {
  return (exitStatus === undefined || exitStatus === 1)
    && isRecord(value)
    && value.v === 1
    && value.ok === false
    && value.kind === 'auth_status'
    && isRecord(value.error)
    && value.error.code === 'not_authenticated';
}

/** The ordinary CLI envelope has the same meaning on every bootstrap transport. */
export function normalizeRemoteBootstrapCliJsonResult(value: unknown, authStatus = false): RemoteCommandResult {
  if (!isRecord(value)) {
    throw new SystemTaskExecutionError('invalid_cli_response', 'Remote bootstrap command returned invalid JSON.');
  }
  if (authStatus) {
    if (value.v !== 1 || typeof value.ok !== 'boolean' || value.kind !== 'auth_status'
      || (value.ok
        ? !isRecord(value.data) || typeof value.data.authenticated !== 'boolean'
        : !isRecord(value.error) || typeof value.error.code !== 'string' || !value.error.code.trim())) {
      throw new SystemTaskExecutionError('invalid_cli_response', 'Remote bootstrap command returned an invalid auth status envelope.');
    }
    if (isRemoteBootstrapUnauthenticatedCliResult(value)) return { ok: true, data: { authenticated: false } };
  }
  // Daemon and service commands also produce plain JSON objects, not CLI envelopes.
  return { ok: value.ok !== false, data: isRecord(value.data) ? value.data : value };
}

function requireOk(result: RemoteCommandResult, label: string): Record<string, unknown> {
  if (!result.ok) {
    throw new SystemTaskExecutionError('remote_command_failed', `Remote bootstrap step failed: ${label}`);
  }
  return result.data;
}

export function createSetupMachineRecipeExecutorFromRemoteCommandRunner(params: Readonly<{
  parsed: RemoteBootstrapMachineParams;
  auth: RemoteSshAuth;
  knownHostsMode: 'app' | 'system';
  localServerUrl?: string;
  serviceMode: 'user' | 'none';
  runRemoteCommand: RemoteSshBootstrapMachineDeps['runRemoteCommand'];
  createHappierJsonExecutor?: RemoteSshBootstrapMachineDeps['createHappierJsonExecutor'];
  signal?: AbortSignal;
}>): SetupMachineRecipeExecutor {
  const remoteExecutor = createRemoteSetupMachineRecipeHappierExecutor(params);
  const shouldManageService = params.serviceMode !== 'none';
  const remoteJsonAdapter: HappierJsonExecutor = {
    runHappierJson: async (args) => requireOk(
      await remoteExecutor.runHappierJson({ args }),
      args.join('.'),
    ),
    runHappierText: async () => {
      throw new SystemTaskExecutionError('unsupported_remote_command', 'Text execution is not available in this recipe.');
    },
  };
  const canonicalReadiness = createSetupMachineRecipeExecutorFromHappierJsonExecutor({
    executor: remoteJsonAdapter,
  });

  return {
    configureRelay: async () => {
      const configured = requireOk(
        await remoteExecutor.runHappierJson({ args: ['server', 'set', '--json'] }),
        'server.configure',
      );
      const active = configured.active;
      return active && typeof active === 'object' && !Array.isArray(active)
        && typeof (active as { id?: unknown }).id === 'string'
        ? String((active as { id: string }).id).trim() || undefined
        : undefined;
    },

    readAuthStatus: async () => {
      const authStatus = requireOk(
        await remoteExecutor.runHappierJson({ args: ['auth', 'status', '--json'] }),
        'auth.status',
      );
      return {
        authenticated: authStatus.authenticated === true,
        credentialState: readCredentialState(authStatus.credentialState),
        machineRegistered: authStatus.machineRegistered === true,
        machineRegistrationState: readMachineRegistrationState(authStatus.machineRegistrationState),
        machineId: typeof authStatus.machineId === 'string' ? authStatus.machineId : null,
      };
    },

    installDaemonService: !shouldManageService
      ? undefined
      : async () => {
          requireOk(
            await remoteExecutor.runHappierJson({ args: ['service', 'install', '--json'] }),
            'daemon.service.install',
          );
        },

    startDaemonService: !shouldManageService
      ? undefined
      : async () => {
          requireOk(
            await remoteExecutor.runHappierJson({ args: ['service', 'start', '--json'] }),
            'daemon.service.start',
          );
        },

    waitForReadyDaemon: !shouldManageService ? undefined : canonicalReadiness.waitForReadyDaemon,
  };
}

function readCredentialState(value: unknown): 'missing' | 'valid' | 'invalid' | 'unknown' | undefined {
  return value === 'missing' || value === 'valid' || value === 'invalid' || value === 'unknown'
    ? value
    : undefined;
}

function readMachineRegistrationState(value: unknown): 'no-local-id' | 'local-only' | 'server-confirmed' | undefined {
  return value === 'no-local-id' || value === 'local-only' || value === 'server-confirmed'
    ? value
    : undefined;
}

export function createRemoteSetupMachineRecipeHappierExecutor(params: Readonly<{
  parsed: RemoteBootstrapMachineParams;
  auth: RemoteSshAuth;
  knownHostsMode: 'app' | 'system';
  localServerUrl?: string;
  runRemoteCommand: RemoteSshBootstrapMachineDeps['runRemoteCommand'];
  createHappierJsonExecutor?: RemoteSshBootstrapMachineDeps['createHappierJsonExecutor'];
  signal?: AbortSignal;
}>): RemoteSshBootstrapHappierJsonExecutor {
  return params.createHappierJsonExecutor?.({
    parsed: params.parsed,
    auth: params.auth,
    knownHostsMode: params.knownHostsMode,
    ...(params.localServerUrl ? { localServerUrl: params.localServerUrl } : {}),
    signal: params.signal,
  }) ?? createRemoteSshBootstrapHappierJsonExecutor({
    parsed: params.parsed,
    auth: params.auth,
    knownHostsMode: params.knownHostsMode,
    ...(params.localServerUrl ? { localServerUrl: params.localServerUrl } : {}),
    runRemoteCommand: params.runRemoteCommand,
    signal: params.signal,
  });
}
