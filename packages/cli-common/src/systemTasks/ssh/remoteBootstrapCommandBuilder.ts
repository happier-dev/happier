import { DEFAULT_HAPPIER_CLOUD_SERVER_URL } from '../../happierCloud.js';
import { quoteRemotePathWithHomeExpansion, safeBashSingleQuote } from '../../ssh/shellQuote.js';
import { resolveRemoteInstalledFirstPartyBinaryPath } from './remoteFirstPartyInstallPath.js';
import { normalizePublicReleaseRingLabel } from '@happier-dev/release-runtime/releaseRings';
import type { ManagedMachineEnrollmentIdentityV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

export const DEDICATED_DAEMON_INSTALL_HOME = '/opt/happier';

/** The bootstrap principal supplies privilege only; every ordinary CLI call runs as the dedicated user. */
export function buildDedicatedDaemonInvocationCommand(command: string): string {
  const userCommand = [
    'set -eu',
    'happier_uid="$(id -u happier)"',
    'test "$happier_uid" -ne 0',
    'happier_home="$(getent passwd happier | cut -d: -f6)"',
    'test -n "$happier_home"',
    `exec runuser -u happier -- env -i HOME="$happier_home" USER=happier LOGNAME=happier SHELL=/bin/bash PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HAPPIER_HOME_DIR="$happier_home/.happier" HAPPIER_FIRST_PARTY_INSTALL_HOME=${DEDICATED_DAEMON_INSTALL_HOME} XDG_RUNTIME_DIR="/run/user/$happier_uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$happier_uid/bus" sh -c ${safeBashSingleQuote(command)}`,
  ].join('; ');
  return buildBootstrapRootCommand(userCommand);
}

/** Fixed bootstrap transport, shared by SSH and native exec. No root daemon fallback. */
export function buildBootstrapRootCommand(command: string): string {
  const invocation = `sh -c ${safeBashSingleQuote(command)}`;
  return `if [ "$(id -u)" -eq 0 ]; then ${invocation}; else sudo -n -- ${invocation}; fi`;
}

/** Account/home creation is the only pre-installer effect; later effects use the installed typed interpreter. */
export function buildDedicatedDaemonAccountCommand(): string {
  return buildBootstrapRootCommand([
    'set -eu',
    'test "$(uname -s)" = Linux',
    'command -v systemctl >/dev/null',
    'command -v loginctl >/dev/null',
    'command -v runuser >/dev/null',
    'test -d /run/systemd/system',
    'if ! id happier >/dev/null 2>&1; then useradd --create-home --user-group --shell /bin/bash happier; usermod --lock happier; fi',
    'happier_uid="$(id -u happier)"',
    'test "$happier_uid" -ne 0',
    'test "$(id -gn happier)" = happier',
    'case "$(passwd -S happier | cut -d\' \' -f2)" in L|LK) ;; *) exit 1 ;; esac',
    'happier_home="$(getent passwd happier | cut -d: -f6)"',
    'test -n "$happier_home" && test "$happier_home" != / && test -d "$happier_home" && test ! -L "$happier_home"',
    'test "$(stat -c %u "$happier_home")" = "$happier_uid"',
    'if [ -e "$happier_home/.happier" ]; then test ! -L "$happier_home/.happier" && test "$(stat -c %u "$happier_home/.happier")" = "$happier_uid"; fi',
    `if [ -e ${DEDICATED_DAEMON_INSTALL_HOME} ]; then test ! -L ${DEDICATED_DAEMON_INSTALL_HOME} && test "$(stat -c %u ${DEDICATED_DAEMON_INSTALL_HOME})" = "$happier_uid"; fi`,
    'install -d -o happier -g happier -m 0700 "$happier_home" "$happier_home/.happier"',
    `install -d -o happier -g happier -m 0755 ${DEDICATED_DAEMON_INSTALL_HOME}`,
  ].join('; '));
}

/** Binary path, literal argv and ring scope are independent of guest transport. */
export function buildRemoteHappierInvocationCommand(params: Readonly<{ binaryPath: string; args: readonly string[]; channel?: string }>): string {
  const argvCommand = [quoteRemotePathWithHomeExpansion(params.binaryPath), ...params.args.map(safeBashSingleQuote)].join(' ');
  const ring = normalizePublicReleaseRingLabel(params.channel);
  return ring && ring !== 'stable'
    ? `HAPPIER_PUBLIC_RELEASE_CHANNEL=${safeBashSingleQuote(ring)} HAPPIER_RELEASE_RING=${safeBashSingleQuote(ring)} ${argvCommand}`
    : argvCommand;
}

type JsonRecord = Record<string, unknown>;

function buildRemoteRelayHostCliInvocation(params: Readonly<{
  happier: string;
  mode: 'user' | 'system';
}>): string {
  return params.mode === 'system' ? `sudo -n ${params.happier}` : params.happier;
}

export type RemoteBootstrapCommandLabel =
  | 'preflight.platform'
  | 'server.configure'
  | 'auth.status'
  | 'daemon.status'
  | 'daemon.service.list'
  | 'daemon.service.install'
  | 'daemon.service.uninstallAll'
  | 'daemon.service.start'
  | 'daemon.service.stop'
  | 'daemon.service.restart'
  | 'relay.runtime.install'
  | 'relay.host.uninstall';

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
  if (!serverUrl || serverUrl !== DEFAULT_HAPPIER_CLOUD_SERVER_URL) return false;
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
  enrollmentIdentity?: ManagedMachineEnrollmentIdentityV1;
  remoteHomeDir?: string;
  data?: JsonRecord;
}>): string {
  if (params.enrollmentIdentity?.kind === 'dedicatedDaemonUser') {
    return buildDedicatedDaemonInvocationCommand(buildRemoteBootstrapCommand({
      ...params, enrollmentIdentity: undefined, daemonServiceMode: 'user', remoteHomeDir: DEDICATED_DAEMON_INSTALL_HOME,
    }));
  }
  const happier = quoteRemotePathWithHomeExpansion(resolveRemoteInstalledFirstPartyBinaryPath({
    componentId: 'happier-cli',
    channel: params.channel,
    remoteHomeDir: params.remoteHomeDir,
  }));

  const useCloudId = shouldUseCloudProfileId(params);
  const relayArgs = buildRelayArgs(params);
  const waitTimeoutMs = params.data?.waitTimeoutMs;
  const serviceWaitArgs = typeof waitTimeoutMs === 'number' && Number.isSafeInteger(waitTimeoutMs) && waitTimeoutMs > 0
    ? ` --wait-timeout-ms ${waitTimeoutMs}` : '';
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
  if (params.label === 'daemon.status') {
    return `${happier} daemon status --json`;
  }
  if (params.label === 'daemon.service.list') {
    return `${happier} service list --json`;
  }
  if (params.label === 'daemon.service.install') {
    const daemonServiceEnv = buildDaemonServiceEnv(params);
    if (params.daemonServiceMode === 'system') {
      return `env ${daemonServiceEnv} sudo -E ${happier} service install --mode=system --system-user "$(id -un)"${serviceWaitArgs} --json`;
    }
    return `${daemonServiceEnv} ${happier} service install --mode=user${serviceWaitArgs} --json`;
  }
  if (params.label === 'daemon.service.uninstallAll') {
    return `${happier} service uninstall --all --yes --json`;
  }
  if (params.label === 'daemon.service.start') {
    const daemonServiceEnv = buildDaemonServiceEnv(params);
    if (params.daemonServiceMode === 'system') {
      return `env ${daemonServiceEnv} sudo -E ${happier} service start --mode=system${serviceWaitArgs} --json`;
    }
    return `${daemonServiceEnv} ${happier} service start --mode=user${serviceWaitArgs} --json`;
  }
  if (params.label === 'daemon.service.stop') {
    if (params.daemonServiceMode === 'system') {
      return `sudo -E ${happier} service stop --mode=system --json`;
    }
    return `${happier} service stop --mode=user --json`;
  }
  if (params.label === 'daemon.service.restart') {
    if (params.daemonServiceMode === 'system') {
      return `sudo -E ${happier} service restart --mode=system --json`;
    }
    return `${happier} service restart --mode=user --json`;
  }
  if (params.label === 'relay.host.uninstall') {
    const relayRuntimeMode = params.data?.relayRuntimeMode === 'system' ? 'system' : 'user';
    const cliInvocation = buildRemoteRelayHostCliInvocation({ happier, mode: relayRuntimeMode });
    return [
      `${cliInvocation} relay host uninstall`,
      `--channel ${safeBashSingleQuote(params.channel ?? 'stable')}`,
      `--mode ${relayRuntimeMode}`,
      '--yes',
      '--json',
    ].join(' ');
  }
  if (params.label === 'relay.runtime.install') {
    const data = params.data ?? {};
    const relayRuntimeMode = data.relayRuntimeMode === 'system' ? 'system' : 'user';
    const cliInvocation = buildRemoteRelayHostCliInvocation({ happier, mode: relayRuntimeMode });
    const relayRuntimeEnv = data.relayRuntimeEnv && typeof data.relayRuntimeEnv === 'object' && !Array.isArray(data.relayRuntimeEnv)
      ? data.relayRuntimeEnv as Record<string, unknown>
      : {};
    const relayRuntimeServerBinaryPath = typeof data.relayRuntimeServerBinaryPath === 'string'
      ? data.relayRuntimeServerBinaryPath.trim()
      : '';
    const envArgs = Object.entries(relayRuntimeEnv).flatMap(([key, value]) => {
      const normalizedKey = key.trim();
      if (!/^[A-Z_][A-Z0-9_]*$/u.test(normalizedKey)) {
        return [];
      }
      return [`--env ${safeBashSingleQuote(`${normalizedKey}=${String(value ?? '')}`)}`];
    });
    return [
      `${cliInvocation} relay host install`,
      `--channel ${safeBashSingleQuote(params.channel ?? 'stable')}`,
      `--mode ${relayRuntimeMode}`,
      ...envArgs,
      ...(relayRuntimeServerBinaryPath
        ? [`--server-binary ${quoteRemotePathWithHomeExpansion(relayRuntimeServerBinaryPath)}`]
        : []),
      '--preserve-active-server',
      '--yes',
      '--json',
    ].join(' ');
  }
  throw new Error(`Unsupported remote bootstrap command: ${params.label satisfies never}`);
}
