import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import type {
  RelayRuntimeStatusSnapshot,
  RelayRuntimeTaskParams,
  SystemTaskSshConnectionConfig,
} from '@happier-dev/cli-common/systemTasks';
import {
  checkRelayRuntimeHealth as checkRelayRuntimeHealthShared,
  installOrUpdateRelayRuntimeLocal,
  listInstalledVersionIdsNewestFirst,
  normalizeRelayRuntimeStatus,
  resolveRelayRuntimeDefaults,
} from '@happier-dev/cli-common/firstPartyRuntime';
import { resolveServiceBackend } from '@happier-dev/cli-common/service';

import { buildSshCommand } from '../ssh/index.js';
import {
  ensureLocalFirstPartyComponentCommand,
} from './localFirstPartyCommand.js';
import { normalizeBootstrapChannel, parseFirstJsonObject, runCommandCapture, type CommandExecutionResult } from './taskRuntime.js';
import { installRemoteFirstPartyComponent, resolveRemoteInstalledFirstPartyBinaryPath } from './remoteFirstPartyPayloadInstaller.js';

export type SshConnectionConfig = SystemTaskSshConnectionConfig;

function shellQuote(value: string): string {
  const raw = String(value ?? '');
  if (!raw) return "''";
  return `'${raw.replaceAll("'", `'\"'\"'`)}'`;
}

export async function readRelayRuntimeStatusDefault(
  params: RelayRuntimeTaskParams,
): Promise<RelayRuntimeStatusSnapshot> {
  const mode = params.mode === 'system' ? 'system' : 'user';
  const commandChannel = normalizeBootstrapChannel(params.channel).commandChannel;

  if (params.target.kind === 'ssh') {
    const remote = await runRemoteJson(
      params.target.ssh,
      `${resolveRemoteInstalledFirstPartyBinaryPath({
        componentId: 'hstack',
        channel: params.channel,
      })} self-host status --json --mode=${mode} --channel=${commandChannel}`,
    ) as null | Readonly<{
      serverUrl?: string | null;
      healthy?: boolean | null;
      versions?: Readonly<{ server?: string | null }>;
      service?: Readonly<{ active?: boolean | null; enabled?: boolean | null }>;
    }>;
    return {
      installed: Boolean(remote?.versions?.server),
      version: remote?.versions?.server ?? null,
      service: {
        active: remote?.service?.active ?? null,
        enabled: remote?.service?.enabled ?? null,
      },
      baseUrl: String(remote?.serverUrl ?? '').trim() || 'http://127.0.0.1:3005',
      healthy: typeof remote?.healthy === 'boolean' ? remote.healthy : null,
    };
  }

  const releaseChannel = normalizeBootstrapChannel(params.channel).releaseChannel;
  const defaults = resolveRelayRuntimeDefaults({
    platform: process.platform,
    mode,
    channel: releaseChannel,
    homeDir: homedir(),
  });
  const separator = process.platform === 'win32' ? '\\' : '/';
  const statePath = `${defaults.installRoot}${separator}self-host-state.json`;
  const binaryName = process.platform === 'win32' ? 'happier-server.exe' : 'happier-server';
  const binaryPath = `${defaults.installRoot}${separator}bin${separator}${binaryName}`;
  const stateText = existsSync(statePath) ? await readFile(statePath, 'utf8').catch(() => '') : '';
  const state = stateText.trim()
    ? parseFirstJsonObject(stateText) as { version?: string }
    : null;

  const backend = resolveServiceBackend({
    platform: process.platform,
    mode,
  });
  const serviceRaw = await queryLocalRelayService({
    backend,
    serviceName: defaults.serviceName,
  });
  const normalized = normalizeRelayRuntimeStatus({
    installVersion: typeof state?.version === 'string'
      ? state.version
      : existsSync(binaryPath)
        ? 'installed'
        : null,
    service: {
      backend,
      raw: serviceRaw,
    },
    health: {
      portOpen: false,
      pingOk: false,
      url: `http://${defaults.serverHost}:${defaults.serverPort}${defaults.healthPath}`,
    },
  });

  return {
    installed: normalized.installed,
    version: typeof state?.version === 'string' ? state.version : null,
    service: {
      active: normalized.service.active,
      enabled: normalized.service.enabled,
    },
    baseUrl: `http://${defaults.serverHost}:${defaults.serverPort}`,
  };
}

export async function checkRelayRuntimeHealthDefault(params: Readonly<{ baseUrl: string }>): Promise<boolean> {
  const url = new URL(params.baseUrl);
  const host = url.hostname;
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const result = await checkRelayRuntimeHealthShared({
    host,
    port,
    timeoutMs: 5_000,
    probePortOpen: async ({ host, port, timeoutMs }) => await probePortOpen({ host, port, timeoutMs }),
    fetchJson: async ({ url, timeoutMs }) => await fetchJson({ url, timeoutMs }),
  });
  return result.reachable;
}

export async function installOrUpdateRelayRuntimeDefault(
  params: RelayRuntimeTaskParams,
  options: Readonly<{
    ensureRemoteCliInstalled?: boolean;
    runLocalServiceCommands?: boolean;
    skipLocalHealthCheck?: boolean;
  }> = {},
  deps: Readonly<{
    installRemoteFirstPartyComponent?: typeof installRemoteFirstPartyComponent;
  }> = {},
): Promise<Readonly<{ relayUrl: string; mode: 'user' | 'system' }>> {
  const installRemoteComponent = deps.installRemoteFirstPartyComponent ?? installRemoteFirstPartyComponent;
  const mode = params.mode === 'system' ? 'system' : 'user';
  const bootstrapChannel = normalizeBootstrapChannel(params.channel);
  const commandChannel = bootstrapChannel.commandChannel;
  const releaseRing = bootstrapChannel.releaseChannel;
  const envArgs = Object.entries(params.env ?? {}).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
  const binaryArgs = params.selfHostRelayBinaryOverride
    ? ['--self-host-server-binary', params.selfHostRelayBinaryOverride]
    : [];

  if (params.target.kind === 'ssh') {
    // Remote relay runtime install still delegates to `hstack self-host` because the remote flow needs:
    // - a remote-first bootstrap of the `hstack` binary (via first-party payload install),
    // - service manager integration on the remote host,
    // - and a JSON status/install contract we can reliably drive over SSH.
    // Local installs are now handled in-process via `@happier-dev/cli-common` to avoid end-user `hstack` dependency.
    const knownHostsMode = params.target.ssh.knownHostsPath ? 'app' : 'system';
    const remoteCliBinaryPath = options.ensureRemoteCliInstalled === false
      ? resolveRemoteInstalledFirstPartyBinaryPath({
        componentId: 'happier-cli',
        channel: params.channel,
      })
      : (await installRemoteComponent({
        componentId: 'happier-cli',
        channel: params.channel,
        ssh: params.target.ssh,
        knownHostsMode,
      })).binaryPath;
    const remoteHstackBinaryPath = (await installRemoteComponent({
      componentId: 'hstack',
      channel: params.channel,
      ssh: params.target.ssh,
      knownHostsMode,
      installerBinaryPath: remoteCliBinaryPath,
    })).binaryPath;
    const remote = await runRemoteJson(
      params.target.ssh,
      [
        remoteHstackBinaryPath,
        'self-host',
        'install',
        `--channel=${commandChannel}`,
        `--mode=${mode}`,
        '--non-interactive',
        '--json',
        ...binaryArgs,
        ...envArgs,
      ].map((value, index) => index === 0 || value.startsWith('$HOME/') ? value : shellQuote(value)).join(' '),
    ) as null | Readonly<{ serverUrl?: string | null }>;
    return {
      relayUrl: String(remote?.serverUrl ?? '').trim() || 'http://127.0.0.1:3005',
      mode,
    };
  }

  const serverBinaryPath = params.selfHostRelayBinaryOverride
    ? params.selfHostRelayBinaryOverride
    : await ensureLocalFirstPartyComponentCommand({
        componentId: 'happier-server',
        processEnv: process.env,
        envVarNames: ['HAPPIER_BOOTSTRAP_SELF_HOST_SERVER_PATH'],
        releaseRing,
      });
  const serverVersion = params.selfHostRelayBinaryOverride
    ? null
    : (await listInstalledVersionIdsNewestFirst({
        componentId: 'happier-server',
        processEnv: process.env,
        releaseRing,
      })).at(0) ?? null;
  const local = await installOrUpdateRelayRuntimeLocal({
    serverBinaryPath,
    channel: releaseRing,
    mode,
    env: params.env,
    version: serverVersion,
    runServiceCommands: options.runLocalServiceCommands !== false,
    skipHealthCheck: options.skipLocalHealthCheck === true,
  });
  return {
    relayUrl: String(local?.baseUrl ?? '').trim() || 'http://127.0.0.1:3005',
    mode,
  };
}

export async function controlRelayRuntimeDefault(
  params: RelayRuntimeTaskParams & Readonly<{ action: 'start' | 'stop' | 'restart' }>,
): Promise<void> {
  const mode = params.mode === 'system' ? 'system' : 'user';
  const releaseChannel = normalizeBootstrapChannel(params.channel).releaseChannel;

  if (params.target.kind === 'ssh') {
    const platformResult = await runRemoteText(params.target.ssh, 'uname -s');
    const remotePlatform = platformResult.stdout.toLowerCase().includes('darwin') ? 'darwin' : 'linux';
    const defaults = resolveRelayRuntimeDefaults({
      platform: remotePlatform,
      mode,
      channel: releaseChannel,
      homeDir: homedir(),
    });
    const command = remotePlatform === 'darwin'
      ? (params.action === 'stop'
        ? `launchctl bootout gui/$UID/${defaults.serviceName}`
        : `launchctl kickstart -k gui/$UID/${defaults.serviceName}`)
      : `${mode === 'user' ? 'systemctl --user' : 'systemctl'} ${params.action} ${defaults.serviceName}.service`;
    const result = await runRemoteText(params.target.ssh, command);
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || `Failed to ${params.action} relay runtime.`);
    }
    return;
  }

  const defaults = resolveRelayRuntimeDefaults({
    platform: process.platform,
    mode,
    channel: releaseChannel,
    homeDir: homedir(),
  });
  const lifecycle = resolveLocalLifecycleCommand({
    platform: process.platform,
    mode,
    serviceName: defaults.serviceName,
    action: params.action,
  });
  const result = await runCommandCapture({
    command: lifecycle.command,
    args: lifecycle.args,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `Failed to ${params.action} relay runtime.`);
  }
}

async function runRemoteJson(ssh: SshConnectionConfig, remoteCommand: string): Promise<unknown> {
  const result = await runRemoteText(ssh, remoteCommand);
  return parseFirstJsonObject(result.stdout);
}

async function runRemoteText(ssh: SshConnectionConfig, remoteCommand: string): Promise<CommandExecutionResult> {
  const invocation = buildSshCommand({
    target: ssh.target,
    port: ssh.port,
    auth: {
      kind: ssh.auth,
      identityFile: ssh.identityFile,
    },
    knownHosts: ssh.knownHostsPath
      ? { mode: 'app', path: ssh.knownHostsPath }
      : { mode: 'system' },
    remoteCommand,
  });
  const result = await runCommandCapture({
    command: invocation.command,
    args: invocation.args,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `SSH command failed for ${ssh.target}.`);
  }
  return result;
}

async function queryLocalRelayService(params: Readonly<{
  backend: string;
  serviceName: string;
}>): Promise<Record<string, unknown>> {
  if (params.backend === 'systemd-user' || params.backend === 'systemd-system') {
    const prefix = params.backend === 'systemd-user' ? ['--user'] : [];
    const result = await runCommandCapture({
      command: 'systemctl',
      args: [...prefix, 'show', `${params.serviceName}.service`, '--property=UnitFileState,ActiveState,SubState', '--value'],
    }).catch(() => ({ status: 1, stdout: '', stderr: '' }));
    const [unitFileState = '', activeState = '', subState = ''] = result.stdout.split(/\r?\n/);
    return {
      unitFileState,
      activeState,
      subState,
    };
  }

  if (params.backend === 'launchd-user' || params.backend === 'launchd-system') {
    const result = await runCommandCapture({
      command: 'launchctl',
      args: ['list', params.serviceName],
    }).catch(() => ({ status: 1, stdout: '', stderr: '' }));
    return {
      loaded: result.status === 0,
      pid: result.status === 0 ? 1 : null,
      lastExitStatus: result.status === 0 ? 0 : null,
    };
  }

  const result = await runCommandCapture({
    command: 'schtasks',
    args: ['/Query', '/TN', `Happier\\${params.serviceName}`, '/FO', 'LIST', '/V'],
  }).catch(() => ({ status: 1, stdout: '', stderr: '' }));
  const output = `${result.stdout}\n${result.stderr}`;
  return {
    exists: result.status === 0,
    enabled: /Scheduled Task State:\s*Enabled/i.test(output),
    active: /Status:\s*Running/i.test(output),
    stateLabel: /Status:\s*(.+)/i.exec(output)?.[1]?.trim() ?? '',
  };
}

function resolveLocalLifecycleCommand(params: Readonly<{
  platform: NodeJS.Platform;
  mode: 'user' | 'system';
  serviceName: string;
  action: 'start' | 'stop' | 'restart';
}>): Readonly<{ command: string; args: readonly string[] }> {
  const backend = resolveServiceBackend({
    platform: params.platform,
    mode: params.mode,
  });
  if (backend === 'systemd-user' || backend === 'systemd-system') {
    const prefix = backend === 'systemd-user' ? ['--user'] : [];
    return {
      command: 'systemctl',
      args: [...prefix, params.action, `${params.serviceName}.service`],
    };
  }
  if (backend === 'launchd-user' || backend === 'launchd-system') {
    const domain = `gui/${process.getuid?.() ?? 0}/${params.serviceName}`;
    return {
      command: 'launchctl',
      args: params.action === 'stop'
        ? ['bootout', domain]
        : ['kickstart', '-k', domain],
    };
  }
  return {
    command: 'schtasks',
    args: params.action === 'stop'
      ? ['/End', '/TN', `Happier\\${params.serviceName}`]
      : ['/Run', '/TN', `Happier\\${params.serviceName}`],
  };
}

async function probePortOpen(params: Readonly<{ host: string; port: number; timeoutMs: number }>): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = createConnection({
      host: params.host,
      port: params.port,
    });
    const finish = (value: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(params.timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function fetchJson(params: Readonly<{ url: string; timeoutMs: number }>): Promise<{
  ok: boolean;
  status: number;
  body: unknown;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const response = await fetch(params.url, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
      },
    });
    return {
      ok: response.ok,
      status: response.status,
      body: await response.json().catch(() => ({})),
    };
  } finally {
    clearTimeout(timeout);
  }
}
