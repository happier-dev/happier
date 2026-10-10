import {
  extractFirstScannedSshKnownHostLine,
  resolveSshKnownHostTrust,
  RemoteBootstrapMachineParams,
  RemoteHostTrustResolution,
  SystemTaskSshConnectionConfig,
  buildRemoteBootstrapCommand,
  isRemoteBootstrapUnauthenticatedCliResult,
  normalizeRemoteBootstrapCliJsonResult,
  SystemTaskExecutionError,
  createOpenSshHappierJsonExecutor,
  type HappierJsonExecutor,
} from '@happier-dev/cli-common/systemTasks';
import {
  createTransferableHomeTargetInput,
  type HomeTargetInput,
} from '@happier-dev/cli-common/homeTarget';
import {
  buildSshKeyscanInvocation,
  normalizeKnownHostsText,
  readKnownHostsText,
  runOpenSshRemoteCommand,
  safeBashSingleQuote,
  type OpenSshAuth,
  writeKnownHostsText,
} from '@happier-dev/cli-common/ssh';

import { runLocalHappierJsonCommand } from './happierCli.js';
import { redactSshText } from '../ssh/index.js';
import { extractSshHost, normalizeBootstrapChannel, parseFirstJsonObject, resolveDefaultKnownHostsPath, runCommandCapture } from './taskRuntime.js';
import { installOrUpdateRelayRuntimeDefault } from './relayRuntimeTasks.js';
import { installRemoteFirstPartyComponent } from './remoteFirstPartyPayloadInstaller.js';

type SshConnectionConfig = SystemTaskSshConnectionConfig;
type SshConnectionWithPasswordConfig = SshConnectionConfig & Readonly<{ password?: string }>;

export async function resolveRemoteSshHostTrustDefault(params: Readonly<{
  ssh: SshConnectionConfig;
  knownHostsMode: 'app' | 'system';
  signal?: AbortSignal;
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
  const keyscan = await runCommandCapture({ ...keyscanInvocation, ...(params.signal ? { signal: params.signal } : {}) });
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
  signal?: AbortSignal;
}>, deps: Readonly<{
  installRemoteFirstPartyComponent?: typeof installRemoteFirstPartyComponent;
}> = {}): Promise<void> {
  const ssh = buildRemoteSshConnection(params.parsed.ssh, params.auth);
  await (deps.installRemoteFirstPartyComponent ?? installRemoteFirstPartyComponent)({
    componentId: 'happier-cli',
    channel: params.parsed.channel,
    ssh,
    knownHostsMode: params.knownHostsMode,
    ...(params.signal ? { signal: params.signal } : {}),
  });
}

export function createRemoteEnrollmentExecutorDefault(params: Readonly<{
  parsed: RemoteBootstrapMachineParams;
  auth: Readonly<{ mode: 'agent' } | { mode: 'keyFile'; privateKeyPath: string } | { mode: 'password'; password: string }>;
  knownHostsMode: 'app' | 'system';
  signal?: AbortSignal;
}>): HappierJsonExecutor {
  const ssh = buildRemoteSshConnection(params.parsed.ssh, params.auth);
  const openSshAuth = resolveOpenSshAuth(ssh);
  return createOpenSshHappierJsonExecutor({
    ssh: params.parsed.ssh,
    auth: openSshAuth,
    knownHostsMode: params.knownHostsMode,
    channel: normalizeBootstrapChannel(params.parsed.channel).releaseChannel,
    runRemoteText: async ({ remoteCommand, input, onStdoutChunk, includeStdoutInError, timeoutMs, signal }) => (
      await runOpenSshRemoteCommand({
        target: ssh.target,
        port: ssh.port,
        sshConfigFile: ssh.sshConfigFile,
        knownHostsMode: params.knownHostsMode,
        knownHostsPath: params.knownHostsMode === 'app'
          ? (ssh.knownHostsPath || resolveDefaultKnownHostsPath())
          : undefined,
        auth: openSshAuth,
        remoteCommand: ['bash', '-lc', safeBashSingleQuote(remoteCommand)],
        signal: signal ?? params.signal,
        timeoutMs,
        input,
        onStdoutChunk,
        includeStdoutInError,
        errorPrefix: `SSH command failed for ${ssh.target}`,
      })
    ),
  });
}

export async function approveLocalRemoteAuthRequestDefault(params: Readonly<{
  publicKey: string;
  pairing?: unknown;
  supportsTokenOnly?: boolean;
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
  const homeTarget: HomeTargetInput = params.parsed.homeTarget
    ? createTransferableHomeTargetInput(params.parsed.homeTarget)
    : {
        kind: 'https_url',
        url: serverUrl,
        ...(localServerUrl ? { localUrl: localServerUrl } : {}),
        ...(webappUrl !== new URL(serverUrl).origin ? { webappUrl } : {}),
      };
  await (deps.runLocalHappierJsonCommand ?? runLocalHappierJsonCommand)({
    args: [
      'auth',
      'approve',
      '--public-key',
      params.publicKey,
      '--json',
      '--request-json-stdin',
      '--home-target-from-request-json',
    ],
    stdinText: `${JSON.stringify({
      publicKey: params.publicKey,
      ...(params.pairing !== undefined && params.pairing !== null ? { pairing: params.pairing } : {}),
      ...(params.supportsTokenOnly === true ? { supportsTokenOnly: true } : {}),
      homeTarget,
    })}\n`,
    releaseRing,
  });
}

export async function runRemoteBootstrapCommandDefault(params: Readonly<{
  label:
    | 'auth.status'
    | 'daemon.status'
    | 'server.configure'
    | 'daemon.service.list'
    | 'daemon.service.install'
    | 'daemon.service.uninstallAll'
    | 'daemon.service.start'
    | 'relay.runtime.install';
  parsed: RemoteBootstrapMachineParams;
  auth: Readonly<{ mode: 'agent' } | { mode: 'keyFile'; privateKeyPath: string } | { mode: 'password'; password: string }>;
  knownHostsMode: 'app' | 'system';
  data?: Record<string, unknown>;
  signal?: AbortSignal;
}>): Promise<Readonly<{ ok: boolean; data: Record<string, unknown> }>> {
  const ssh = buildRemoteSshConnection(params.parsed.ssh, params.auth);
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
  if (params.label === 'relay.runtime.install') {
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

  const command = buildRemoteBootstrapCommand({
    label: params.label,
    channel: params.parsed.channel,
    serverUrl,
    webappUrl,
    ...(shouldPreferLocal ? { localServerUrl: relayLocalServerUrl } : {}),
    daemonServiceMode: params.parsed.serviceMode,
    data: params.data,
  });

  const authStatus = params.label === 'auth.status';
  const result = await runRemoteJson(ssh, command, params.knownHostsMode, params.signal, authStatus);
  return normalizeRemoteBootstrapCliJsonResult(result, authStatus);
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
  signal?: AbortSignal,
  authStatus = false,
): Promise<unknown> {
  const result = await runRemoteText(ssh, remoteCommand, knownHostsMode, signal);
  const parsed = parseFirstJsonObject(result.stdout);
  if (result.status !== 0 && !(authStatus && isRemoteBootstrapUnauthenticatedCliResult(parsed, result.status))) {
    throw new SystemTaskExecutionError(
      'remote_command_failed',
      redactSshText(result.stderr.trim() || result.stdout.trim() || `SSH command failed for ${ssh.target}`),
    );
  }
  return parsed;
}

async function runRemoteText(
  ssh: SshConnectionWithPasswordConfig,
  remoteCommand: string,
  knownHostsMode: 'app' | 'system',
  signal?: AbortSignal,
): Promise<Readonly<{ status: number; stdout: string; stderr: string }>> {
  const auth = resolveOpenSshAuth(ssh);

  return await runOpenSshRemoteCommand({
    target: ssh.target,
    port: ssh.port,
    sshConfigFile: ssh.sshConfigFile,
    knownHostsMode,
    knownHostsPath: knownHostsMode === 'app'
      ? (ssh.knownHostsPath || resolveDefaultKnownHostsPath())
      : undefined,
    auth,
    remoteCommand: ['bash', '-lc', safeBashSingleQuote(remoteCommand)],
    signal,
    rejectOnNonZero: false,
    errorPrefix: `SSH command failed for ${ssh.target}`,
  });
}

function resolveOpenSshAuth(ssh: SshConnectionWithPasswordConfig): OpenSshAuth {
  return ssh.auth === 'keyfile'
    ? { mode: 'keyFile', privateKeyPath: String(ssh.identityFile ?? '') }
    : ssh.auth === 'password'
      ? { mode: 'password', password: String(ssh.password ?? '') }
      : { mode: 'agent' };
}
