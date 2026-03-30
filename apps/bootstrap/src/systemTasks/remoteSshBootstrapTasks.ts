import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  extractFirstScannedSshKnownHostLine,
  resolveSshKnownHostTrust,
  RemoteBootstrapMachineParams,
  RemoteHostTrustResolution,
  SystemTaskSshConnectionConfig,
} from '@happier-dev/cli-common/systemTasks';

import { runLocalHappierJsonCommand } from './happierCli.js';
import { buildSshCommand, redactSshText } from '../ssh/index.js';
import { extractSshHost, normalizeBootstrapChannel, parseFirstJsonObject, resolveDefaultKnownHostsPath, runCommandCapture } from './taskRuntime.js';
import { installOrUpdateRelayRuntimeDefault } from './relayRuntimeTasks.js';
import { installRemoteFirstPartyComponent, resolveRemoteInstalledFirstPartyBinaryPath } from './remoteFirstPartyPayloadInstaller.js';

type SshConnectionConfig = SystemTaskSshConnectionConfig;

function shellQuote(value: string): string {
  const raw = String(value ?? '');
  if (!raw) return "''";
  return `'${raw.replaceAll("'", `'\"'\"'`)}'`;
}

function normalizeKnownHostsText(text: string): string {
  const normalized = String(text ?? '').trim();
  return normalized ? `${normalized}\n` : '';
}

async function writeKnownHostsText(path: string, text: string): Promise<void> {
  const normalizedPath = String(path ?? '').trim();
  if (!normalizedPath) {
    return;
  }
  const slashIndex = Math.max(normalizedPath.lastIndexOf('/'), normalizedPath.lastIndexOf('\\'));
  if (slashIndex > 0) {
    await mkdir(normalizedPath.slice(0, slashIndex), { recursive: true });
  }
  await writeFile(normalizedPath, normalizeKnownHostsText(text), 'utf8');
}

export async function resolveRemoteSshHostTrustDefault(params: Readonly<{
  ssh: SshConnectionConfig;
  knownHostsMode: 'app' | 'system';
}>): Promise<RemoteHostTrustResolution> {
  if (params.knownHostsMode === 'system') {
    return { status: 'trusted' };
  }

  const knownHostsPath = params.ssh.knownHostsPath || resolveDefaultKnownHostsPath();
  const host = extractSshHost(params.ssh.target);
  const existingText = await readFile(knownHostsPath, 'utf8').catch(() => '');

  const keyscan = await runCommandCapture({
    command: 'ssh-keyscan',
    args: [
      '-T',
      '5',
      ...(params.ssh.port ? ['-p', String(params.ssh.port)] : []),
      '-t',
      'ed25519',
      host,
    ],
  });
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
  auth: Readonly<{ mode: 'agent' } | { mode: 'keyFile'; privateKeyPath: string }>;
  knownHostsMode: 'app' | 'system';
}>, deps: Readonly<{
  installRemoteFirstPartyComponent?: typeof installRemoteFirstPartyComponent;
}> = {}): Promise<void> {
  await (deps.installRemoteFirstPartyComponent ?? installRemoteFirstPartyComponent)({
    componentId: 'happier-cli',
    channel: params.parsed.channel,
    ssh: {
      ...params.parsed.ssh,
      auth: params.auth.mode === 'keyFile' ? 'keyfile' : 'agent',
      ...(params.auth.mode === 'keyFile' ? { identityFile: params.auth.privateKeyPath } : {}),
    },
    knownHostsMode: params.knownHostsMode,
  });
}

export async function approveLocalRemoteAuthRequestDefault(params: Readonly<{
  publicKey: string;
  parsed: RemoteBootstrapMachineParams;
}>, deps: Readonly<{
  runLocalHappierJsonCommand?: typeof runLocalHappierJsonCommand;
}> = {}): Promise<void> {
  const relayArgs = [
    `--server-url=${params.parsed.relay.relayUrl}`,
    `--webapp-url=${params.parsed.relay.webappUrl ?? params.parsed.relay.relayUrl}`,
    ...(params.parsed.relay.publicRelayUrl ? [`--public-server-url=${params.parsed.relay.publicRelayUrl}`] : []),
  ];
  await (deps.runLocalHappierJsonCommand ?? runLocalHappierJsonCommand)({
    args: ['auth', 'approve', '--public-key', params.publicKey, '--json', '--persist', ...relayArgs],
  });
}

export async function runRemoteBootstrapCommandDefault(params: Readonly<{
  label:
    | 'auth.status'
    | 'server.configure'
    | 'auth.request'
    | 'auth.wait'
    | 'daemon.service.install'
    | 'daemon.service.start'
    | 'relay.runtime.install';
  parsed: RemoteBootstrapMachineParams;
  auth: Readonly<{ mode: 'agent' } | { mode: 'keyFile'; privateKeyPath: string }>;
  knownHostsMode: 'app' | 'system';
  data?: Record<string, unknown>;
}>): Promise<Readonly<{ ok: boolean; data: Record<string, unknown> }>> {
  const ssh: SshConnectionConfig = {
    ...params.parsed.ssh,
    auth: params.auth.mode === 'keyFile' ? 'keyfile' : 'agent',
    ...(params.auth.mode === 'keyFile' ? { identityFile: params.auth.privateKeyPath } : {}),
  };
  const happier = resolveRemoteInstalledFirstPartyBinaryPath({
    componentId: 'happier-cli',
    channel: params.parsed.channel,
  });
  const relayArgs = [
    `--server-url=${params.parsed.relay.relayUrl}`,
    `--webapp-url=${params.parsed.relay.webappUrl ?? params.parsed.relay.relayUrl}`,
    ...(params.parsed.relay.publicRelayUrl ? [`--public-server-url=${params.parsed.relay.publicRelayUrl}`] : []),
  ];
  const daemonEnv = [
    `HAPPIER_DAEMON_SERVICE_SERVER_URL=${shellQuote(params.parsed.relay.relayUrl)}`,
    `HAPPIER_DAEMON_SERVICE_WEBAPP_URL=${shellQuote(params.parsed.relay.webappUrl ?? params.parsed.relay.relayUrl)}`,
    ...(params.parsed.relay.publicRelayUrl ? [`HAPPIER_DAEMON_SERVICE_PUBLIC_SERVER_URL=${shellQuote(params.parsed.relay.publicRelayUrl)}`] : []),
  ].join(' ');

  let command = '';
  if (params.label === 'auth.status') {
    command = `${happier} auth status --json`;
  } else if (params.label === 'server.configure') {
    command = `${happier} server set ${relayArgs.map(shellQuote).join(' ')} --json`;
  } else if (params.label === 'auth.request') {
    command = `${happier} auth request --json --persist ${relayArgs.map(shellQuote).join(' ')}`;
  } else if (params.label === 'auth.wait') {
    command = `${happier} auth wait --public-key ${shellQuote(String(params.data?.publicKey ?? ''))} --json --persist ${relayArgs.map(shellQuote).join(' ')}`;
  } else if (params.label === 'daemon.service.install') {
    command = `${daemonEnv} ${happier} daemon service install --mode=${params.parsed.serviceMode === 'none' ? 'user' : params.parsed.serviceMode ?? 'user'} --json`;
  } else if (params.label === 'daemon.service.start') {
    command = `${daemonEnv} ${happier} daemon service start --mode=${params.parsed.serviceMode === 'none' ? 'user' : params.parsed.serviceMode ?? 'user'} --json`;
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

async function runRemoteJson(
  ssh: SshConnectionConfig,
  remoteCommand: string,
  knownHostsMode: 'app' | 'system',
): Promise<unknown> {
  const result = await runRemoteText(ssh, remoteCommand, knownHostsMode);
  return parseFirstJsonObject(result.stdout);
}

async function runRemoteText(
  ssh: SshConnectionConfig,
  remoteCommand: string,
  knownHostsMode: 'app' | 'system',
): Promise<Readonly<{ status: number; stdout: string; stderr: string }>> {
  const invocation = buildSshCommand({
    target: ssh.target,
    port: ssh.port,
    auth: {
      kind: ssh.auth,
      identityFile: ssh.identityFile,
    },
    knownHosts: knownHostsMode === 'app'
      ? { mode: 'app', path: ssh.knownHostsPath || resolveDefaultKnownHostsPath() }
      : { mode: 'system' },
    remoteCommand,
  });
  const result = await runCommandCapture({
    command: invocation.command,
    args: invocation.args,
  });
  if (result.status !== 0) {
    throw new Error(redactSshText(result.stderr || result.stdout || `SSH command failed for ${ssh.target}.`));
  }
  return result;
}
