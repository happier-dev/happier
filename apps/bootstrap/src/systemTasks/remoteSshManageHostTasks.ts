import {
  createRemoteSshPersonalHomeRelocationDestination,
  createOpenSshHappierJsonExecutor,
  createOpenSshRemoteCliTransport,
  parseStrictPersonalHomeTaskFinalResult,
  type RelayRuntimeTaskParams,
  type SystemTaskSshConnectionConfig,
} from '@happier-dev/cli-common/systemTasks';
import { installRemoteCli } from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';
import {
  type PersonalHomeRelocationDestinationOwner,
} from '@happier-dev/cli-common/firstPartyRuntime';
import {
  type SystemTaskJsonObject,
} from '@happier-dev/protocol';
import type { OpenSshAuth } from '@happier-dev/cli-common/ssh';
import {
  runOpenSshRemoteCommand,
  safeBashSingleQuote,
  transferOpenSshFile,
} from '@happier-dev/cli-common/ssh';

import { redactSshText } from '../ssh/index.js';
import { checkRelayRuntimeHealthDefault, controlRelayRuntimeDefault, installOrUpdateRelayRuntimeDefault, readRelayRuntimeStatusDefault } from './relayRuntimeTasks.js';
import { normalizeBootstrapChannel, resolveDefaultKnownHostsPath } from './taskRuntime.js';
import { resolveRemoteInstalledFirstPartyBinaryPath } from './remoteFirstPartyPayloadInstaller.js';

type RemoteSshAuth =
  | Readonly<{ mode: 'agent' }>
  | Readonly<{ mode: 'keyFile'; privateKeyPath: string }>
  | Readonly<{ mode: 'password'; password: string }>;

type SshConnectionWithPasswordConfig = SystemTaskSshConnectionConfig & Readonly<{ password?: string }>;

function buildRemoteSshConnection(
  ssh: SystemTaskSshConnectionConfig,
  auth: RemoteSshAuth,
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

function resolveKnownHostsConfig(
  ssh: SystemTaskSshConnectionConfig,
  knownHostsMode: 'app' | 'system',
): Readonly<{ mode: 'app'; path: string } | { mode: 'system' }> {
  if (knownHostsMode === 'system') return { mode: 'system' };
  return { mode: 'app', path: ssh.knownHostsPath || resolveDefaultKnownHostsPath() };
}

function resolveOpenSshAuth(ssh: SshConnectionWithPasswordConfig): OpenSshAuth {
  return ssh.auth === 'keyfile'
    ? { mode: 'keyFile', privateKeyPath: String(ssh.identityFile ?? '') }
    : ssh.auth === 'password'
      ? { mode: 'password', password: String(ssh.password ?? '') }
      : { mode: 'agent' };
}

async function runRemoteText(params: Readonly<{
  ssh: SshConnectionWithPasswordConfig;
  knownHosts: Readonly<{ mode: 'app'; path: string } | { mode: 'system' }>;
  auth: OpenSshAuth;
  remoteCommand: string;
  input?: string;
  signal?: AbortSignal;
  timeoutMs?: number | null;
  errorPrefix: string;
}>) {
  return await runOpenSshRemoteCommand({
    target: params.ssh.target,
    port: params.ssh.port,
    sshConfigFile: params.ssh.sshConfigFile,
    knownHostsMode: params.knownHosts.mode,
    knownHostsPath: params.knownHosts.mode === 'app' ? params.knownHosts.path : undefined,
    auth: params.auth,
    remoteCommand: ['bash', '-lc', safeBashSingleQuote(params.remoteCommand)],
    connectTimeoutSec: 10,
    ...(params.input === undefined ? {} : { input: params.input }),
    signal: params.signal,
    timeoutMs: params.timeoutMs,
    errorPrefix: params.errorPrefix,
  });
}

export async function testRemoteSshConnectionDefault(params: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
  auth: RemoteSshAuth;
  knownHostsMode: 'app' | 'system';
  signal?: AbortSignal;
}>): Promise<void> {
  const ssh = buildRemoteSshConnection(params.ssh, params.auth);
  const knownHosts = resolveKnownHostsConfig(ssh, params.knownHostsMode);
  const auth: OpenSshAuth = ssh.auth === 'keyfile'
    ? { mode: 'keyFile', privateKeyPath: String(ssh.identityFile ?? '') }
    : ssh.auth === 'password'
      ? { mode: 'password', password: String(ssh.password ?? '') }
      : { mode: 'agent' };

  await runRemoteText({
    ssh,
    knownHosts,
    auth,
    remoteCommand: 'true',
    ...(params.signal ? { signal: params.signal } : {}),
    errorPrefix: `SSH connection failed for ${ssh.target}`,
  });
}

export async function installRemoteCliForManageHostDefault(params: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
  auth: RemoteSshAuth;
  knownHostsMode: 'app' | 'system';
  channel: 'stable' | 'preview' | 'dev';
  purpose?: 'personal-home';
  signal?: AbortSignal;
}>): Promise<void> {
  const { ssh, auth, channel, knownHostsMode, purpose, signal } = params;
  const knownHosts = resolveKnownHostsConfig(ssh, knownHostsMode);
  await installRemoteCli({
    channel,
    purpose,
    signal,
    transport: createOpenSshRemoteCliTransport({
      ssh: buildRemoteSshConnection(ssh, auth),
      auth,
      channel,
      knownHostsMode,
      ...(knownHosts.mode === 'app' ? { knownHostsPath: knownHosts.path } : {}),
      signal,
    }),
  });
}

export async function runRemoteDaemonServiceCommandDefault(params: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
  auth: RemoteSshAuth;
  knownHostsMode: 'app' | 'system';
  action: 'installOrUpdate' | 'start' | 'stop' | 'restart';
  serviceMode: 'user' | 'none';
  channel: 'stable' | 'preview' | 'dev';
  signal?: AbortSignal;
}>): Promise<void> {
  const ssh = buildRemoteSshConnection(params.ssh, params.auth);
  const knownHosts = resolveKnownHostsConfig(ssh, params.knownHostsMode);
  const { releaseChannel } = normalizeBootstrapChannel(params.channel);
  const happier = resolveRemoteInstalledFirstPartyBinaryPath({
    componentId: 'happier-cli',
    channel: releaseChannel === 'publicdev' ? 'dev' : releaseChannel,
  });
  const mode = params.serviceMode === 'none' ? 'user' : params.serviceMode;
  const action = params.action === 'installOrUpdate' ? 'install' : params.action;
  const auth: OpenSshAuth = ssh.auth === 'keyfile'
    ? { mode: 'keyFile', privateKeyPath: String(ssh.identityFile ?? '') }
    : ssh.auth === 'password'
      ? { mode: 'password', password: String(ssh.password ?? '') }
      : { mode: 'agent' };

  await runRemoteText({
    ssh,
    knownHosts,
    auth,
    remoteCommand: `${happier} service ${action} --mode=${mode} --json`,
    ...(params.signal ? { signal: params.signal } : {}),
    errorPrefix: `Remote background service command failed for ${ssh.target}`,
  });
}

export async function runRemoteRelayRuntimeCommandDefault(params: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
  auth: RemoteSshAuth;
  knownHostsMode: 'app' | 'system';
  action: 'status' | 'installOrUpdate' | 'start' | 'stop' | 'restart';
  channel: 'stable' | 'preview' | 'dev';
  mode: 'user' | 'system';
  purpose?: Extract<RelayRuntimeTaskParams['purpose'], { kind: 'personal-home' }>;
  signal?: AbortSignal;
}>): Promise<SystemTaskJsonObject | null> {
  const ssh = buildRemoteSshConnection(params.ssh, params.auth);
  const taskParams: RelayRuntimeTaskParams = {
    target: {
      kind: 'ssh',
      ssh,
    },
    channel: params.channel,
    mode: params.mode,
    ...(params.purpose ? { purpose: params.purpose } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  };

  if (params.action === 'status') {
    const snapshot = await readRelayRuntimeStatusDefault(taskParams);
    const healthy = typeof snapshot.healthy === 'boolean'
      ? snapshot.healthy
      : await checkRelayRuntimeHealthDefault({ baseUrl: snapshot.baseUrl });
    return {
      installed: snapshot.installed,
      version: snapshot.version,
      relayUrl: snapshot.baseUrl,
      healthy,
      service: {
        active: snapshot.service.active,
        enabled: snapshot.service.enabled,
      },
    } satisfies SystemTaskJsonObject;
  }

  if (params.action === 'installOrUpdate') {
    const installed = await installOrUpdateRelayRuntimeDefault(taskParams, {
      ensureRemoteCliInstalled: false,
    });
    return {
      relayUrl: installed.relayUrl,
      mode: installed.mode,
    } satisfies SystemTaskJsonObject;
  }

  await controlRelayRuntimeDefault({
    ...taskParams,
    action: params.action,
  });
  return null;
}

export async function runRemotePersonalHomeCommandDefault(params: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
  auth: RemoteSshAuth;
  knownHostsMode: 'app' | 'system';
  channel: 'stable' | 'preview' | 'dev';
  mode: 'user' | 'system';
  args: readonly string[];
  input?: string;
  resultContract?: 'create' | 'task';
  timeoutMs?: number | null;
  signal?: AbortSignal;
}>): Promise<SystemTaskJsonObject> {
  const ssh = buildRemoteSshConnection(params.ssh, params.auth);
  const knownHosts = resolveKnownHostsConfig(ssh, params.knownHostsMode);
  const auth: OpenSshAuth = ssh.auth === 'keyfile'
    ? { mode: 'keyFile', privateKeyPath: String(ssh.identityFile ?? '') }
    : ssh.auth === 'password'
      ? { mode: 'password', password: String(ssh.password ?? '') }
      : { mode: 'agent' };
  const executor = createOpenSshHappierJsonExecutor({
    ssh,
    auth,
    knownHostsMode: params.knownHostsMode,
    channel: params.channel === 'dev' ? 'publicdev' : params.channel,
    runRemoteText: async ({ remoteCommand, input, signal, timeoutMs }) => {
      signal?.throwIfAborted();
      return await runRemoteText({
        ssh,
        knownHosts,
        auth,
        remoteCommand,
        ...(input === undefined ? {} : { input }),
        signal,
        timeoutMs,
        errorPrefix: `Remote Personal Home command failed for ${ssh.target}`,
      });
    },
  });
  if (params.resultContract === 'create') {
    const envelope = await executor.runHappierJson(params.args, {
      signal: params.signal,
      timeoutMs: params.timeoutMs,
      ...(params.input === undefined ? {} : { input: params.input }),
    });
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      throw new Error('Remote Personal Home creation did not return an object result.');
    }
    return envelope as SystemTaskJsonObject;
  }
  const output = await executor.runHappierText(params.args, {
    signal: params.signal,
    timeoutMs: params.timeoutMs,
    ...(params.input === undefined ? {} : { input: params.input }),
  });
  if (output.status !== 0) {
    throw new Error(redactSshText(output.stderr || output.stdout || `Remote Personal Home command failed for ${ssh.target}.`));
  }
  const data = parseStrictPersonalHomeTaskFinalResult(output.stdout).data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Remote Personal Home command did not return an object result.');
  }
  return data;
}

/**
 * Source-facing adapter for the destination-local relocation owner. Archive paths supplied to
 * `stage` are local to the source host; the operation-scoped remote transfer path stays private to
 * this SSH boundary and is removed after the installed destination CLI has consumed it.
 */
export function createRemoteSshPersonalHomeRelocationDestinationDefault(params: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
  auth: RemoteSshAuth;
  knownHostsMode: 'app' | 'system';
  channel: 'stable' | 'preview' | 'dev';
  mode: 'user' | 'system';
  ensureRuntime(
    purpose: Extract<RelayRuntimeTaskParams['purpose'], { kind: 'personal-home' }>,
    signal?: AbortSignal,
  ): Promise<void>;
}>): PersonalHomeRelocationDestinationOwner {
  const ssh = buildRemoteSshConnection(params.ssh, params.auth);
  const knownHosts = resolveKnownHostsConfig(ssh, params.knownHostsMode);
  const auth = resolveOpenSshAuth(ssh);
  return createRemoteSshPersonalHomeRelocationDestination({
    ...params,
    runPersonalHomeCommand: async ({ args, signal }) => await runRemotePersonalHomeCommandDefault({
      ssh: params.ssh,
      auth: params.auth,
      knownHostsMode: params.knownHostsMode,
      channel: params.channel,
      mode: params.mode,
      args,
      ...(signal ? { signal } : {}),
    }),
    transferPersonalHomeArchive: async ({ direction, localPath, remotePath, signal }) => {
      try {
        await transferOpenSshFile({
          direction,
          target: ssh.target,
          port: ssh.port,
          sshConfigFile: ssh.sshConfigFile,
          knownHostsMode: knownHosts.mode,
          knownHostsPath: knownHosts.mode === 'app' ? knownHosts.path : undefined,
          auth,
          localPath,
          remotePath,
          connectTimeoutSec: 10,
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        throw new Error(redactSshText(error instanceof Error ? error.message : 'Personal Home relocation archive transfer failed.'));
      }
    },
    ensureRuntime: async (purpose, signal) => await params.ensureRuntime(purpose, signal),
  });
}
