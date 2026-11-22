import type {
  RemoteBootstrapMachineParams,
  RemoteSshAuth,
  RemoteSshBootstrapHappierJsonExecutor,
  RemoteSshBootstrapMachineDeps,
} from '../kinds/remoteSshBootstrapMachineKind.js';

type RemoteLabel = Parameters<RemoteSshBootstrapMachineDeps['runRemoteCommand']>[0]['label'];

function resolveRemoteLabelFromArgs(args: readonly string[]): RemoteLabel {
  if (args[0] === 'server' && args[1] === 'set') return 'server.configure';
  if (args[0] === 'auth' && args[1] === 'status') return 'auth.status';
  if (args[0] === 'daemon' && args[1] === 'status') return 'daemon.status';
  if (args[0] === 'service' && args[1] === 'list') return 'daemon.service.list';
  if (args[0] === 'service' && args[1] === 'install') return 'daemon.service.install';
  if (args[0] === 'service' && args[1] === 'uninstall' && args.includes('--all')) return 'daemon.service.uninstallAll';
  if (args[0] === 'service' && args[1] === 'start') return 'daemon.service.start';
  if (args[0] === 'daemon' && args[1] === 'service' && args[2] === 'list') return 'daemon.service.list';
  if (args[0] === 'daemon' && args[1] === 'service' && args[2] === 'install') return 'daemon.service.install';
  if (args[0] === 'daemon' && args[1] === 'service' && args[2] === 'uninstall' && args.includes('--all')) return 'daemon.service.uninstallAll';
  if (args[0] === 'daemon' && args[1] === 'service' && args[2] === 'start') return 'daemon.service.start';
  if (args[0] === 'relay' && args[1] === 'runtime' && args[2] === 'install') return 'relay.runtime.install';
  throw new Error(`Unsupported SSH happier-json invocation: ${JSON.stringify(args)}`);
}

export function createRemoteSshBootstrapHappierJsonExecutor(params: Readonly<{
  parsed: RemoteBootstrapMachineParams;
  auth: RemoteSshAuth;
  knownHostsMode: 'app' | 'system';
  localServerUrl?: string;
  runRemoteCommand: RemoteSshBootstrapMachineDeps['runRemoteCommand'];
  signal?: AbortSignal;
}>): RemoteSshBootstrapHappierJsonExecutor {
  return {
    runHappierJson: async ({ args, timeoutMs }) => {
      const label = resolveRemoteLabelFromArgs(args);
      const data: Record<string, unknown> = {
        ...(params.localServerUrl ? { localServerUrl: params.localServerUrl } : {}),
      };
      const timeoutIndex = args.indexOf('--wait-timeout-ms');
      if (timeoutIndex >= 0) data.waitTimeoutMs = Number(args[timeoutIndex + 1]);
      return await params.runRemoteCommand({
        label,
        parsed: params.parsed,
        auth: params.auth,
        knownHostsMode: params.knownHostsMode,
        signal: params.signal,
        timeoutMs,
        ...(Object.keys(data).length ? { data } : {}),
      });
    },
  };
}
