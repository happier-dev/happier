import { SystemTaskExecutionError } from '../runSystemTask.js';
import type { SetupMachineRecipeExecutor } from '../recipes/setupMachineRecipe.js';
import type {
  RemoteBootstrapMachineParams,
  RemoteSshAuth,
  RemoteSshBootstrapHappierJsonExecutor,
  RemoteSshBootstrapMachineDeps,
} from '../kinds/remoteSshBootstrapMachineKind.js';

import { createRemoteSshBootstrapHappierJsonExecutor } from './remoteSshBootstrapHappierJsonExecutor.js';

type RemoteCommandResult = Awaited<ReturnType<RemoteSshBootstrapHappierJsonExecutor['runHappierJson']>>;

function requireOk(result: RemoteCommandResult, label: string): Record<string, unknown> {
  if (!result.ok) {
    throw new SystemTaskExecutionError('remote_command_failed', `Remote bootstrap step failed: ${label}`);
  }
  return result.data;
}

function ensureNonEmptyString(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    throw new SystemTaskExecutionError('invalid_params', `Missing ${field}.`);
  }
  return text;
}

export function createSetupMachineRecipeExecutorFromRemoteCommandRunner(params: Readonly<{
  parsed: RemoteBootstrapMachineParams;
  auth: RemoteSshAuth;
  knownHostsMode: 'app' | 'system';
  localServerUrl?: string;
  serviceMode: 'user' | 'none';
  installRemoteCli: RemoteSshBootstrapMachineDeps['installRemoteCli'];
  runRemoteCommand: RemoteSshBootstrapMachineDeps['runRemoteCommand'];
  createHappierJsonExecutor?: RemoteSshBootstrapMachineDeps['createHappierJsonExecutor'];
}>): SetupMachineRecipeExecutor {
  const remoteExecutor = createRemoteSetupMachineRecipeHappierExecutor(params);
  const shouldManageService = params.serviceMode !== 'none';

  return {
    configureRelay: async () => {
      try {
        requireOk(
          await remoteExecutor.runHappierJson({ args: ['server', 'set', '--json'] }),
          'server.configure',
        );
      } catch {
        await params.installRemoteCli({
          parsed: params.parsed,
          auth: params.auth,
          knownHostsMode: params.knownHostsMode,
        });
        requireOk(
          await remoteExecutor.runHappierJson({ args: ['server', 'set', '--json'] }),
          'server.configure',
        );
      }
    },

    readAuthStatus: async () => {
      const authStatus = requireOk(
        await remoteExecutor.runHappierJson({ args: ['auth', 'status', '--json'] }),
        'auth.status',
      );
      return {
        authenticated: authStatus.authenticated === true,
        machineId: typeof authStatus.machineId === 'string' ? authStatus.machineId : null,
      };
    },

    requestAuthPairing: async () => {
      const authRequest = requireOk(
        await remoteExecutor.runHappierJson({ args: ['auth', 'request', '--json'] }),
        'auth.request',
      );
      return {
        ...authRequest,
        publicKey: ensureNonEmptyString(authRequest.publicKey, 'auth.request.publicKey'),
      };
    },

    waitForAuthPairing: async (publicKey) => {
      const authWait = requireOk(
        await remoteExecutor.runHappierJson({ args: ['auth', 'wait', '--public-key', publicKey, '--json'] }),
        'auth.wait',
      );
      return {
        machineId: typeof authWait.machineId === 'string' ? authWait.machineId : null,
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
  };
}

export function createRemoteSetupMachineRecipeHappierExecutor(params: Readonly<{
  parsed: RemoteBootstrapMachineParams;
  auth: RemoteSshAuth;
  knownHostsMode: 'app' | 'system';
  localServerUrl?: string;
  runRemoteCommand: RemoteSshBootstrapMachineDeps['runRemoteCommand'];
  createHappierJsonExecutor?: RemoteSshBootstrapMachineDeps['createHappierJsonExecutor'];
}>): RemoteSshBootstrapHappierJsonExecutor {
  return params.createHappierJsonExecutor?.({
    parsed: params.parsed,
    auth: params.auth,
    knownHostsMode: params.knownHostsMode,
    ...(params.localServerUrl ? { localServerUrl: params.localServerUrl } : {}),
  }) ?? createRemoteSshBootstrapHappierJsonExecutor({
    parsed: params.parsed,
    auth: params.auth,
    knownHostsMode: params.knownHostsMode,
    ...(params.localServerUrl ? { localServerUrl: params.localServerUrl } : {}),
    runRemoteCommand: params.runRemoteCommand,
  });
}
