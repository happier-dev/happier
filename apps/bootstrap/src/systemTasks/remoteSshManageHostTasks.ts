import type { RelayRuntimeTaskParams, SystemTaskSshConnectionConfig } from '@happier-dev/cli-common/systemTasks';
import type { SystemTaskJsonObject } from '@happier-dev/protocol';
import type { OpenSshAuth } from '@happier-dev/cli-common/ssh';
import { runRemoteTextSync } from '@happier-dev/cli-common/ssh';

import { redactSshText } from '../ssh/index.js';
import { checkRelayRuntimeHealthDefault, controlRelayRuntimeDefault, installOrUpdateRelayRuntimeDefault, readRelayRuntimeStatusDefault } from './relayRuntimeTasks.js';
import { normalizeBootstrapChannel, resolveDefaultKnownHostsPath } from './taskRuntime.js';
import { installRemoteFirstPartyComponent, resolveRemoteInstalledFirstPartyBinaryPath } from './remoteFirstPartyPayloadInstaller.js';

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

export async function testRemoteSshConnectionDefault(params: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
  auth: RemoteSshAuth;
  knownHostsMode: 'app' | 'system';
}>): Promise<void> {
  const ssh = buildRemoteSshConnection(params.ssh, params.auth);
  const knownHosts = resolveKnownHostsConfig(ssh, params.knownHostsMode);
  const auth: OpenSshAuth = ssh.auth === 'keyfile'
    ? { mode: 'keyFile', privateKeyPath: String(ssh.identityFile ?? '') }
    : ssh.auth === 'password'
      ? { mode: 'password', password: String(ssh.password ?? '') }
      : { mode: 'agent' };

  runRemoteTextSync({
    target: ssh.target,
    port: ssh.port,
    sshConfigFile: ssh.sshConfigFile,
    knownHostsMode: knownHosts.mode === 'app' ? 'app' : 'system',
    knownHostsPath: knownHosts.mode === 'app' ? knownHosts.path : undefined,
    auth,
    remoteCommand: 'true',
    connectTimeoutSec: 10,
    errorPrefix: `SSH connection failed for ${ssh.target}`,
  });
}

export async function installRemoteCliForManageHostDefault(params: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
  auth: RemoteSshAuth;
  knownHostsMode: 'app' | 'system';
  channel: 'stable' | 'preview' | 'dev';
}>): Promise<void> {
  const ssh = buildRemoteSshConnection(params.ssh, params.auth);
  const { releaseChannel } = normalizeBootstrapChannel(params.channel);
  await installRemoteFirstPartyComponent({
    componentId: 'happier-cli',
    channel: releaseChannel === 'publicdev' ? 'dev' : releaseChannel,
    ssh,
    knownHostsMode: params.knownHostsMode,
  });
}

export async function runRemoteDaemonServiceCommandDefault(params: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
  auth: RemoteSshAuth;
  knownHostsMode: 'app' | 'system';
  action: 'installOrUpdate' | 'start' | 'stop' | 'restart';
  serviceMode: 'user' | 'none';
  channel: 'stable' | 'preview' | 'dev';
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

  runRemoteTextSync({
    target: ssh.target,
    port: ssh.port,
    sshConfigFile: ssh.sshConfigFile,
    knownHostsMode: knownHosts.mode === 'app' ? 'app' : 'system',
    knownHostsPath: knownHosts.mode === 'app' ? knownHosts.path : undefined,
    auth,
    remoteCommand: `${happier} daemon service ${action} --mode=${mode} --json`,
    connectTimeoutSec: 10,
    errorPrefix: `Remote daemon service command failed for ${ssh.target}`,
  });
}

export async function runRemoteRelayRuntimeCommandDefault(params: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
  auth: RemoteSshAuth;
  knownHostsMode: 'app' | 'system';
  action: 'status' | 'installOrUpdate' | 'start' | 'stop' | 'restart';
  channel: 'stable' | 'preview' | 'dev';
  mode: 'user' | 'system';
}>): Promise<SystemTaskJsonObject | null> {
  const ssh = buildRemoteSshConnection(params.ssh, params.auth);
  const taskParams: RelayRuntimeTaskParams = {
    target: {
      kind: 'ssh',
      ssh,
    },
    channel: params.channel,
    mode: params.mode,
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
