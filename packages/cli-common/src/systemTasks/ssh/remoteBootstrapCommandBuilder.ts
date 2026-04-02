import { safeBashSingleQuote } from '../../ssh/shellQuote.js';
import { resolveRemoteInstalledFirstPartyBinaryPath } from '../kinds/remoteFirstPartyPayloadInstaller.js';

type JsonRecord = Record<string, unknown>;

export type RemoteBootstrapCommandLabel =
  | 'preflight.platform'
  | 'server.configure'
  | 'auth.status'
  | 'auth.request'
  | 'auth.wait'
  | 'daemon.service.install'
  | 'daemon.service.start';

function deriveWebappUrl(serverUrl: string, explicitWebappUrl?: string): string {
  if (typeof explicitWebappUrl === 'string' && explicitWebappUrl.trim()) {
    return explicitWebappUrl;
  }
  try {
    return new URL(serverUrl).origin;
  } catch {
    return serverUrl;
  }
}

function normalizeServerUrlForBootstrap(url: string): string {
  return String(url ?? '').trim().replace(/\/+$/, '');
}

function shouldUseCloudProfileId(params: Readonly<{ serverUrl: string; localServerUrl?: string }>): boolean {
  const serverUrl = normalizeServerUrlForBootstrap(params.serverUrl);
  if (serverUrl !== 'https://api.happier.dev') return false;
  const localServerUrl = typeof params.localServerUrl === 'string' ? normalizeServerUrlForBootstrap(params.localServerUrl) : '';
  return !localServerUrl || localServerUrl === serverUrl;
}

function buildRelayArgs(params: Readonly<{
  serverUrl: string;
  localServerUrl?: string;
  webappUrl?: string;
  includeLocalServerUrl?: boolean;
}>): string {
  const includeLocalServerUrl = params.includeLocalServerUrl !== false;
  const serverUrl = params.serverUrl.trim();
  const localServerUrl = typeof params.localServerUrl === 'string' ? params.localServerUrl.trim() : '';
  const args = [
    `--server-url ${safeBashSingleQuote(serverUrl)}`,
    ...(includeLocalServerUrl && localServerUrl && localServerUrl !== serverUrl
      ? [`--local-server-url ${safeBashSingleQuote(localServerUrl)}`]
      : []),
    `--webapp-url ${safeBashSingleQuote(deriveWebappUrl(serverUrl, params.webappUrl))}`,
  ];
  return args.join(' ');
}

function buildDaemonServiceEnv(params: Readonly<{
  serverUrl: string;
  localServerUrl?: string;
  webappUrl?: string;
}>): string {
  const localServerUrl = typeof params.localServerUrl === 'string' ? params.localServerUrl.trim() : '';
  const serverUrl = params.serverUrl.trim();
  const shouldPreferLocal = Boolean(localServerUrl) && localServerUrl !== serverUrl;
  const daemonServerUrl = shouldPreferLocal ? localServerUrl : serverUrl;
  const env = [
    `HAPPIER_DAEMON_SERVICE_SERVER_URL=${safeBashSingleQuote(daemonServerUrl)}`,
    `HAPPIER_DAEMON_SERVICE_WEBAPP_URL=${safeBashSingleQuote(deriveWebappUrl(serverUrl, params.webappUrl))}`,
    ...(shouldPreferLocal
      ? [`HAPPIER_DAEMON_SERVICE_PUBLIC_SERVER_URL=${safeBashSingleQuote(serverUrl)}`]
      : []),
  ];
  return env.join(' ');
}

export function buildRemoteBootstrapCommand(params: Readonly<{
  label: RemoteBootstrapCommandLabel;
  serverUrl: string;
  localServerUrl?: string;
  channel?: string;
  webappUrl?: string;
  daemonServiceMode?: 'none' | 'user' | 'system';
  data?: JsonRecord;
}>): string {
  const happier = resolveRemoteInstalledFirstPartyBinaryPath({
    componentId: 'happier-cli',
    channel: params.channel,
  });

  const useCloudId = shouldUseCloudProfileId(params);
  const relayArgs = buildRelayArgs(params);
  const authRelayArgs = buildRelayArgs({
    ...params,
    includeLocalServerUrl: false,
  });
  const authRelaySelectionArgs = useCloudId ? '--server cloud' : authRelayArgs;

  if (params.label === 'preflight.platform') {
    return "printf '{\"platform\":\"%s\"}\\n' \"$(uname -s | tr '[:upper:]' '[:lower:]')\"";
  }
  if (params.label === 'server.configure') {
    if (useCloudId) {
      return `${happier} server use cloud --json`;
    }
    return `${happier} server set ${relayArgs} --json`;
  }
  if (params.label === 'auth.status') {
    return `${happier} auth status --json`;
  }
  if (params.label === 'auth.request') {
    return `${happier} auth request --json --persist ${authRelaySelectionArgs}`;
  }
  if (params.label === 'auth.wait') {
    const publicKey = safeBashSingleQuote(String(params.data?.publicKey ?? '').trim());
    return `${happier} auth wait --public-key ${publicKey} --json --persist ${authRelaySelectionArgs}`;
  }
  if (params.label === 'daemon.service.install') {
    const daemonServiceEnv = buildDaemonServiceEnv(params);
    if (params.daemonServiceMode === 'system') {
      return `env ${daemonServiceEnv} sudo -E ${happier} daemon service install --mode=system --system-user "$(id -un)" --json`;
    }
    return `${daemonServiceEnv} ${happier} daemon service install --mode=user --json`;
  }
  if (params.label === 'daemon.service.start') {
    const daemonServiceEnv = buildDaemonServiceEnv(params);
    if (params.daemonServiceMode === 'system') {
      return `env ${daemonServiceEnv} sudo -E ${happier} daemon service start --mode=system --json`;
    }
    return `${daemonServiceEnv} ${happier} daemon service start --mode=user --json`;
  }
  throw new Error(`Unsupported remote bootstrap command: ${params.label satisfies never}`);
}
