import { resolveRemoteInstalledFirstPartyBinaryPath } from '@happier-dev/cli-common/systemTasks';

import { safeBashSingleQuote } from './sshTransport';

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

function buildRelayArgs(params: Readonly<{
  serverUrl: string;
  webappUrl?: string;
  publicServerUrl?: string;
}>): string {
  const args = [
    `--server-url ${safeBashSingleQuote(params.serverUrl)}`,
    `--webapp-url ${safeBashSingleQuote(deriveWebappUrl(params.serverUrl, params.webappUrl))}`,
  ];
  if (typeof params.publicServerUrl === 'string' && params.publicServerUrl.trim()) {
    args.push(`--public-server-url ${safeBashSingleQuote(params.publicServerUrl)}`);
  }
  return args.join(' ');
}

function buildDaemonServiceEnv(params: Readonly<{
  serverUrl: string;
  webappUrl?: string;
  publicServerUrl?: string;
}>): string {
  const env = [
    `HAPPIER_DAEMON_SERVICE_SERVER_URL=${safeBashSingleQuote(params.serverUrl)}`,
    `HAPPIER_DAEMON_SERVICE_WEBAPP_URL=${safeBashSingleQuote(deriveWebappUrl(params.serverUrl, params.webappUrl))}`,
  ];
  if (typeof params.publicServerUrl === 'string' && params.publicServerUrl.trim()) {
    env.push(`HAPPIER_DAEMON_SERVICE_PUBLIC_SERVER_URL=${safeBashSingleQuote(params.publicServerUrl)}`);
  }
  return env.join(' ');
}

export function buildRemoteBootstrapCommand(params: Readonly<{
  label: RemoteBootstrapCommandLabel;
  serverUrl: string;
  channel?: string;
  webappUrl?: string;
  publicServerUrl?: string;
  daemonServiceMode?: 'none' | 'user' | 'system';
  data?: JsonRecord;
}>): string {
  const happier = resolveRemoteInstalledFirstPartyBinaryPath({
    componentId: 'happier-cli',
    channel: params.channel,
  });
  const relayArgs = buildRelayArgs(params);

  if (params.label === 'preflight.platform') {
    return "printf '{\"platform\":\"%s\"}\\n' \"$(uname -s | tr '[:upper:]' '[:lower:]')\"";
  }
  if (params.label === 'server.configure') {
    return `${happier} server set ${relayArgs} --json`;
  }
  if (params.label === 'auth.status') {
    return `${happier} auth status --json`;
  }
  if (params.label === 'auth.request') {
    return `${happier} auth request --json --persist ${relayArgs}`;
  }
  if (params.label === 'auth.wait') {
    const publicKey = safeBashSingleQuote(String(params.data?.publicKey ?? '').trim());
    return `${happier} auth wait --public-key ${publicKey} --json --persist ${relayArgs}`;
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
