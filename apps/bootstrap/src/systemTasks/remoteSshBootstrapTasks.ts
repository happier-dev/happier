import {
  extractFirstScannedSshKnownHostLine,
  resolveSshKnownHostTrust,
  RemoteBootstrapMachineParams,
  RemoteHostTrustResolution,
  SystemTaskSshConnectionConfig,
} from '@happier-dev/cli-common/systemTasks';
import {
  buildSshKeyscanInvocation,
  normalizeKnownHostsText,
  readKnownHostsText,
  runRemoteTextSync,
  safeBashSingleQuote,
  type OpenSshAuth,
  writeKnownHostsText,
} from '@happier-dev/cli-common/ssh';

import { runLocalHappierJsonCommand } from './happierCli.js';
import { redactSshText } from '../ssh/index.js';
import { extractSshHost, normalizeBootstrapChannel, parseFirstJsonObject, resolveDefaultKnownHostsPath, runCommandCapture } from './taskRuntime.js';
import { installOrUpdateRelayRuntimeDefault } from './relayRuntimeTasks.js';
import { installRemoteFirstPartyComponent, resolveRemoteInstalledFirstPartyBinaryPath } from './remoteFirstPartyPayloadInstaller.js';

type SshConnectionConfig = SystemTaskSshConnectionConfig;
type SshConnectionWithPasswordConfig = SshConnectionConfig & Readonly<{ password?: string }>;

export async function resolveRemoteSshHostTrustDefault(params: Readonly<{
  ssh: SshConnectionConfig;
  knownHostsMode: 'app' | 'system';
}>): Promise<RemoteHostTrustResolution> {
  if (params.knownHostsMode === 'system') {
    return { status: 'trusted' };
  }

  const knownHostsPath = params.ssh.knownHostsPath || resolveDefaultKnownHostsPath();
  const host = extractSshHost(params.ssh.target);
  const existingText = await readKnownHostsText(knownHostsPath);

  const keyscanInvocation = buildSshKeyscanInvocation({
    host,
    port: params.ssh.port,
    timeoutSec: 5,
    keyType: 'ed25519',
  });
  const keyscan = await runCommandCapture(keyscanInvocation);
  if (keyscan.status !== 0 || !keyscan.stdout.trim()) {
    throw new Error(redactSshText(keyscan.stderr || 'Failed to resolve SSH host key.'));
  }

  const scanned = extractFirstScannedSshKnownHostLine(keyscan.stdout);
  const trust = resolveSshKnownHostTrust({
    knownHostsText: existingText,
    scannedHostKeyLine: scanned.line,
    trustedHostKey: params.ssh.trustedHostKey,
  });

  if (trust.status === 'rejected') {
    throw new Error(trust.message);
  }

  if (trust.status === 'trusted') {
    if (normalizeKnownHostsText(trust.nextKnownHostsText) !== normalizeKnownHostsText(existingText)) {
      await writeKnownHostsText(knownHostsPath, trust.nextKnownHostsText);
    }
    return { status: 'trusted' };
  }

  return {
    status: 'prompt',
    promptKind: trust.promptKind,
    promptMessage: trust.promptKind === 'ssh.replaceHostKey'
      ? 'Replace the saved SSH host key?'
      : 'Trust this SSH host?',
    promptData: {
      host: trust.scanned.host,
      keyType: trust.scanned.keyType,
      fingerprint: trust.scanned.fingerprint,
      ...(trust.promptKind === 'ssh.replaceHostKey'
        ? { existingFingerprint: trust.existingFingerprint ?? null }
        : {}),
    },
    accept: async () => {
      await writeKnownHostsText(knownHostsPath, trust.nextKnownHostsText);
    },
  };
}

export async function installRemoteCliDefault(params: Readonly<{
  parsed: RemoteBootstrapMachineParams;
  auth: Readonly<{ mode: 'agent' } | { mode: 'keyFile'; privateKeyPath: string } | { mode: 'password'; password: string }>;
  knownHostsMode: 'app' | 'system';
}>, deps: Readonly<{
  installRemoteFirstPartyComponent?: typeof installRemoteFirstPartyComponent;
}> = {}): Promise<void> {
  const ssh = buildRemoteSshConnection(params.parsed.ssh, params.auth);
  await (deps.installRemoteFirstPartyComponent ?? installRemoteFirstPartyComponent)({
    componentId: 'happier-cli',
    channel: params.parsed.channel,
    ssh,
    knownHostsMode: params.knownHostsMode,
  });
}

export async function approveLocalRemoteAuthRequestDefault(params: Readonly<{
  publicKey: string;
  parsed: RemoteBootstrapMachineParams;
}>, deps: Readonly<{
  runLocalHappierJsonCommand?: typeof runLocalHappierJsonCommand;
}> = {}): Promise<void> {
  const releaseRing = normalizeBootstrapChannel(params.parsed.channel).releaseChannel;
  const serverUrl = (params.parsed.relay.publicRelayUrl ?? params.parsed.relay.relayUrl).trim();
  const webappUrl = (params.parsed.relay.webappUrl ?? params.parsed.relay.relayUrl).trim();
  const localServerUrl = params.parsed.relay.publicRelayUrl
    && params.parsed.relay.publicRelayUrl.trim()
    && params.parsed.relay.publicRelayUrl.trim() !== params.parsed.relay.relayUrl.trim()
      ? params.parsed.relay.relayUrl.trim()
      : '';
  const relayArgs = [
    `--server-url=${serverUrl}`,
    ...(localServerUrl ? [`--local-server-url=${localServerUrl}`] : []),
    `--webapp-url=${webappUrl}`,
  ];
  await (deps.runLocalHappierJsonCommand ?? runLocalHappierJsonCommand)({
    args: ['auth', 'approve', '--public-key', params.publicKey, '--json', '--persist', ...relayArgs],
    releaseRing,
  });
}

export async function runRemoteBootstrapCommandDefault(params: Readonly<{
  label:
    | 'auth.status'
    | 'server.configure'
    | 'auth.request'
    | 'auth.wait'
    | 'daemon.service.list'
    | 'daemon.service.install'
    | 'daemon.service.uninstallAll'
    | 'daemon.service.start'
    | 'relay.runtime.install';
  parsed: RemoteBootstrapMachineParams;
  auth: Readonly<{ mode: 'agent' } | { mode: 'keyFile'; privateKeyPath: string } | { mode: 'password'; password: string }>;
  knownHostsMode: 'app' | 'system';
  data?: Record<string, unknown>;
}>): Promise<Readonly<{ ok: boolean; data: Record<string, unknown> }>> {
  const ssh = buildRemoteSshConnection(params.parsed.ssh, params.auth);
  const happier = resolveRemoteInstalledFirstPartyBinaryPath({
    componentId: 'happier-cli',
    channel: params.parsed.channel,
  });
  const serverUrl = (params.parsed.relay.publicRelayUrl ?? params.parsed.relay.relayUrl).trim();
  const webappUrl = (params.parsed.relay.webappUrl ?? serverUrl).trim();
  const derivedRelayLocalServerUrl = params.parsed.relay.publicRelayUrl
    && params.parsed.relay.publicRelayUrl.trim()
    && params.parsed.relay.publicRelayUrl.trim() !== params.parsed.relay.relayUrl.trim()
      ? params.parsed.relay.relayUrl.trim()
      : '';
  const relayLocalServerUrl = typeof params.data?.localServerUrl === 'string'
    ? params.data.localServerUrl.trim()
    : derivedRelayLocalServerUrl;
  const shouldPreferLocal = Boolean(relayLocalServerUrl) && relayLocalServerUrl !== serverUrl;
  const daemonServerUrl = shouldPreferLocal ? relayLocalServerUrl : serverUrl;

  const relayArgs = [
    `--server-url=${serverUrl}`,
    ...(shouldPreferLocal ? [`--local-server-url=${relayLocalServerUrl}`] : []),
    `--webapp-url=${webappUrl}`,
  ];
  const authRelayArgs = [
    `--server-url=${serverUrl}`,
    `--webapp-url=${webappUrl}`,
  ];
  const daemonEnv = [
    `HAPPIER_DAEMON_SERVICE_SERVER_URL=${safeBashSingleQuote(daemonServerUrl)}`,
    `HAPPIER_DAEMON_SERVICE_WEBAPP_URL=${safeBashSingleQuote(webappUrl)}`,
    ...(shouldPreferLocal
      ? [`HAPPIER_DAEMON_SERVICE_PUBLIC_SERVER_URL=${safeBashSingleQuote(serverUrl)}`]
      : []),
  ].join(' ');

  let command = '';
  if (params.label === 'auth.status') {
    command = `${happier} auth status --json`;
  } else if (params.label === 'server.configure') {
    command = `${happier} server set ${relayArgs.map(safeBashSingleQuote).join(' ')} --json`;
  } else if (params.label === 'daemon.service.list') {
    command = `${happier} service list --json`;
  } else if (params.label === 'daemon.service.uninstallAll') {
    command = `${happier} service uninstall --all --yes --json`;
  } else if (params.label === 'auth.request') {
    command = `${happier} auth request --json --persist ${authRelayArgs.map(safeBashSingleQuote).join(' ')}`;
  } else if (params.label === 'auth.wait') {
    command = `${happier} auth wait --public-key ${safeBashSingleQuote(String(params.data?.publicKey ?? ''))} --json --persist ${authRelayArgs.map(safeBashSingleQuote).join(' ')}`;
  } else if (params.label === 'daemon.service.install') {
    command = `${daemonEnv} ${happier} service install --mode=${params.parsed.serviceMode === 'none' ? 'user' : params.parsed.serviceMode ?? 'user'} --json`;
  } else if (params.label === 'daemon.service.start') {
    command = `${daemonEnv} ${happier} service start --mode=${params.parsed.serviceMode === 'none' ? 'user' : params.parsed.serviceMode ?? 'user'} --json`;
  } else if (params.label === 'relay.runtime.install') {
    const installed = await installOrUpdateRelayRuntimeDefault({
      target: {
        kind: 'ssh',
        ssh,
      },
      channel: params.parsed.channel,
      mode: params.parsed.relayRuntime?.mode ?? 'user',
      env: params.parsed.relayRuntime?.env,
      selfHostRelayBinaryOverride: params.parsed.relayRuntime?.selfHostRelayBinaryOverride,
    }, {
      ensureRemoteCliInstalled: false,
    });
    return {
      ok: true,
      data: {
        relayUrl: installed.relayUrl,
        mode: installed.mode,
      },
    };
  }

  const result = await runRemoteJson(ssh, command, params.knownHostsMode) as null | Readonly<{
    ok?: boolean;
    data?: Record<string, unknown>;
  }>;
  if (params.label === 'auth.status') {
    if (result?.ok === false) {
      return {
        ok: true,
        data: { authenticated: false },
      };
    }
    if (result?.data && typeof result.data === 'object') {
      return {
        ok: true,
        data: result.data,
      };
    }
  }

  if (result?.data && typeof result.data === 'object') {
    return {
      ok: result.ok !== false,
      data: result.data,
    };
  }

  return {
    ok: result?.ok !== false,
    data: (result ?? {}) as Record<string, unknown>,
  };
}

function buildRemoteSshConnection(
  ssh: SshConnectionConfig,
  auth: Readonly<{ mode: 'agent' } | { mode: 'keyFile'; privateKeyPath: string } | { mode: 'password'; password: string }>,
): SshConnectionWithPasswordConfig {
  return {
    ...ssh,
    auth: auth.mode === 'keyFile'
      ? 'keyfile'
      : auth.mode === 'password'
        ? 'password'
        : 'agent',
    ...(auth.mode === 'keyFile' ? { identityFile: auth.privateKeyPath } : {}),
    ...(auth.mode === 'password' ? { password: auth.password } : {}),
  };
}

async function runRemoteJson(
  ssh: SshConnectionWithPasswordConfig,
  remoteCommand: string,
  knownHostsMode: 'app' | 'system',
): Promise<unknown> {
  const result = await runRemoteText(ssh, remoteCommand, knownHostsMode);
  return parseFirstJsonObject(result.stdout);
}

async function runRemoteText(
  ssh: SshConnectionWithPasswordConfig,
  remoteCommand: string,
  knownHostsMode: 'app' | 'system',
): Promise<Readonly<{ status: number; stdout: string; stderr: string }>> {
  const auth: OpenSshAuth = ssh.auth === 'keyfile'
    ? { mode: 'keyFile', privateKeyPath: String(ssh.identityFile ?? '') }
    : ssh.auth === 'password'
      ? { mode: 'password', password: String(ssh.password ?? '') }
      : { mode: 'agent' };

  return runRemoteTextSync({
    target: ssh.target,
    port: ssh.port,
    sshConfigFile: ssh.sshConfigFile,
    knownHostsMode,
    knownHostsPath: knownHostsMode === 'app'
      ? (ssh.knownHostsPath || resolveDefaultKnownHostsPath())
      : undefined,
    auth,
    remoteCommand,
    errorPrefix: `SSH command failed for ${ssh.target}`,
  });
}
