import type {
  RemoteBootstrapMachineParams,
  RemoteSshAuth,
  RemoteSshBootstrapHappierJsonExecutor,
  RemoteSshBootstrapMachineDeps,
} from '../kinds/remoteSshBootstrapMachineKind.js';

type RemoteLabel = Parameters<RemoteSshBootstrapMachineDeps['runRemoteCommand']>[0]['label'];

function readFlagValue(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  if (index < 0) return '';
  return typeof args[index + 1] === 'string' ? String(args[index + 1]).trim() : '';
}

function resolveRemoteLabelFromArgs(args: readonly string[]): RemoteLabel {
  if (args[0] === 'server' && args[1] === 'set') return 'server.configure';
  if (args[0] === 'auth' && args[1] === 'status') return 'auth.status';
  if (args[0] === 'auth' && args[1] === 'request') return 'auth.request';
  if (args[0] === 'auth' && args[1] === 'wait') return 'auth.wait';
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
}>): RemoteSshBootstrapHappierJsonExecutor {
  return {
    runHappierJson: async ({ args }) => {
      const label = resolveRemoteLabelFromArgs(args);
      const publicKey = label === 'auth.wait'
        ? readFlagValue(args, '--public-key')
        : '';
      const data: Record<string, unknown> = {
        ...(params.localServerUrl ? { localServerUrl: params.localServerUrl } : {}),
        ...(publicKey ? { publicKey } : {}),
      };
      return await params.runRemoteCommand({
        label,
        parsed: params.parsed,
        auth: params.auth,
        knownHostsMode: params.knownHostsMode,
        ...(Object.keys(data).length ? { data } : {}),
      });
    },
  };
}
