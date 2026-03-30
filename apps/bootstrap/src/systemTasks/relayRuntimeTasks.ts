import { createConnection } from 'node:net';
import {
  createRelayHostEngine,
  installRemoteFirstPartyComponent as installRemoteFirstPartyComponentShared,
  normalizeRemoteReleaseArch,
  normalizeRemoteReleaseOs,
  type RelayHostEngineDeps,
  type RelayRuntimeStatusSnapshot,
  type RelayRuntimeTaskParams,
  type SystemTaskSshConnectionConfig,
} from '@happier-dev/cli-common/systemTasks';
import {
  checkRelayRuntimeHealth as checkRelayRuntimeHealthShared,
  listInstalledVersionIdsNewestFirst,
} from '@happier-dev/cli-common/firstPartyRuntime';

import { buildScpCommand, buildSshCommand, redactSshText } from '../ssh/index.js';
import {
  ensureLocalFirstPartyComponentCommand,
} from './localFirstPartyCommand.js';
import { normalizeBootstrapChannel, parseFirstJsonObject, runCommandCapture, type CommandExecutionResult } from './taskRuntime.js';

export type SshConnectionConfig = SystemTaskSshConnectionConfig;

function shellQuote(value: string): string {
  const raw = String(value ?? '');
  if (!raw) return "''";
  return `'${raw.replaceAll("'", `'\"'\"'`)}'`;
}

export async function readRelayRuntimeStatusDefault(
  params: RelayRuntimeTaskParams,
): Promise<RelayRuntimeStatusSnapshot> {
  const engine = createRelayHostEngine(buildRelayHostEngineDeps());
  return await engine.readStatus(params);
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
    installRemoteFirstPartyComponent?: (params: Readonly<{
      componentId: 'happier-cli' | 'happier-server';
      channel?: string;
      ssh: SshConnectionConfig;
      knownHostsMode?: 'app' | 'system';
      installerBinaryPath?: string;
      remoteHomeDir?: string;
    }>) => Promise<Readonly<{ binaryPath: string; versionId: string; source: string | null }>>;
  }> = {},
): Promise<Readonly<{ relayUrl: string; mode: 'user' | 'system' }>> {
  const mode = params.mode === 'system' ? 'system' : 'user';
  const bootstrapChannel = normalizeBootstrapChannel(params.channel);
  const releaseRing = bootstrapChannel.releaseChannel;

  const engine = createRelayHostEngine(buildRelayHostEngineDeps({
    installRemoteFirstPartyComponent: deps.installRemoteFirstPartyComponent,
    localInstallPolicy: {
      runServiceCommands: options.runLocalServiceCommands !== false,
      skipHealthCheck: options.skipLocalHealthCheck === true,
    },
    resolveLocalInstallVersion: async () => {
      if (params.selfHostRelayBinaryOverride) {
        return null;
      }
      return (await listInstalledVersionIdsNewestFirst({
        componentId: 'happier-server',
        processEnv: process.env,
        releaseRing,
      })).at(0) ?? null;
    },
  }));

  if (params.target.kind === 'ssh') {
    return await engine.installOrUpdate({
      ...params,
      mode,
      channel: releaseRing === 'publicdev' ? 'dev' : releaseRing,
    });
  }

  const serverBinaryPath = params.selfHostRelayBinaryOverride
    ? params.selfHostRelayBinaryOverride
    : await ensureLocalFirstPartyComponentCommand({
        componentId: 'happier-server',
        processEnv: process.env,
        envVarNames: ['HAPPIER_BOOTSTRAP_SELF_HOST_SERVER_PATH'],
        releaseRing,
      });

  return await engine.installOrUpdate({
    ...params,
    mode,
    channel: releaseRing === 'publicdev' ? 'dev' : releaseRing,
    selfHostRelayBinaryOverride: serverBinaryPath,
  });
}

export async function controlRelayRuntimeDefault(
  params: RelayRuntimeTaskParams & Readonly<{ action: 'start' | 'stop' | 'restart' }>,
): Promise<void> {
  const engine = createRelayHostEngine(buildRelayHostEngineDeps());
  await engine.control(params);
}

function resolveKnownHostsConfig(ssh: SshConnectionConfig, knownHostsMode?: 'app' | 'system') {
  const mode = knownHostsMode === 'app' || knownHostsMode === 'system'
    ? knownHostsMode
    : ssh.knownHostsPath
      ? 'app'
      : 'system';
  return mode === 'app'
    ? { mode: 'app' as const, path: ssh.knownHostsPath ?? '' }
    : { mode: 'system' as const };
}

async function runRemoteTextCapture(ssh: SshConnectionConfig, remoteCommand: string, knownHostsMode?: 'app' | 'system'): Promise<CommandExecutionResult> {
  const invocation = buildSshCommand({
    target: ssh.target,
    port: ssh.port,
    auth: {
      kind: ssh.auth,
      identityFile: ssh.identityFile,
    },
    knownHosts: resolveKnownHostsConfig(ssh, knownHostsMode),
    remoteCommand,
  });
  const result = await runCommandCapture({
    command: invocation.command,
    args: invocation.args,
  });
  return result;
}

async function copyLocalDirectoryToRemoteCapture(params: Readonly<{
  ssh: SshConnectionConfig;
  localPath: string;
  remotePath: string;
  knownHostsMode?: 'app' | 'system';
}>): Promise<void> {
  const invocation = buildScpCommand({
    target: params.ssh.target,
    remotePath: params.remotePath,
    localPath: params.localPath,
    port: params.ssh.port,
    auth: {
      kind: params.ssh.auth,
      identityFile: params.ssh.identityFile,
    },
    knownHosts: resolveKnownHostsConfig(params.ssh, params.knownHostsMode),
  });
  const result = await runCommandCapture({
    command: invocation.command,
    args: invocation.args,
  });
  if (result.status !== 0) {
    throw new Error(redactSshText(result.stderr || result.stdout || `SCP command failed for ${params.ssh.target}.`));
  }
}

function buildRelayHostEngineDeps(params: Readonly<{
  installRemoteFirstPartyComponent?: (params: Readonly<{
    componentId: 'happier-cli' | 'happier-server';
    channel?: string;
    ssh: SshConnectionConfig;
    knownHostsMode?: 'app' | 'system';
    installerBinaryPath?: string;
    remoteHomeDir?: string;
  }>) => Promise<Readonly<{ binaryPath: string; versionId: string; source: string | null }>>;
  localInstallPolicy?: RelayHostEngineDeps['localInstallPolicy'];
  resolveLocalInstallVersion?: RelayHostEngineDeps['resolveLocalInstallVersion'];
}> = {}): RelayHostEngineDeps {
  const installRemoteFirstPartyComponent = params.installRemoteFirstPartyComponent
    ?? (async (installParams) => await installRemoteFirstPartyComponentShared(installParams, {
      resolveRemoteReleaseTarget: async ({ ssh, knownHostsMode }) => {
        const preflight = await runRemoteTextCapture(
          ssh,
          [
            "printf '{\"platform\":\"%s\",\"arch\":\"%s\"}\\n'",
            '"$(uname -s | tr \'[:upper:]\' \'[:lower:]\')"',
            '"$(uname -m | tr \'[:upper:]\' \'[:lower:]\')"',
          ].join(' '),
          knownHostsMode,
        );
        if (preflight.status !== 0) {
          throw new Error(redactSshText(preflight.stderr || preflight.stdout || `SSH command failed for ${ssh.target}.`));
        }
        const parsed = parseFirstJsonObject(preflight.stdout) as null | Readonly<{ platform?: unknown; arch?: unknown }>;
        return {
          os: normalizeRemoteReleaseOs(parsed?.platform),
          arch: normalizeRemoteReleaseArch(parsed?.arch),
        };
      },
      runRemoteText: async ({ ssh, remoteCommand, knownHostsMode }) => {
        const result = await runRemoteTextCapture(ssh, remoteCommand, knownHostsMode);
        return result;
      },
      copyLocalDirectoryToRemote: async ({ ssh, localPath, remotePath, knownHostsMode }) => {
        await copyLocalDirectoryToRemoteCapture({ ssh, localPath, remotePath, knownHostsMode });
      },
    }));

  return {
    resolveRemoteReleaseTarget: async ({ ssh, knownHostsMode }) => {
      const preflight = await runRemoteTextCapture(
        ssh,
        [
          "printf '{\"platform\":\"%s\",\"arch\":\"%s\"}\\n'",
          '"$(uname -s | tr \'[:upper:]\' \'[:lower:]\')"',
          '"$(uname -m | tr \'[:upper:]\' \'[:lower:]\')"',
        ].join(' '),
        knownHostsMode,
      );
      if (preflight.status !== 0) {
        throw new Error(redactSshText(preflight.stderr || preflight.stdout || `SSH command failed for ${ssh.target}.`));
      }
      const parsed = parseFirstJsonObject(preflight.stdout) as null | Readonly<{ platform?: unknown; arch?: unknown }>;
      return {
        os: normalizeRemoteReleaseOs(parsed?.platform),
        arch: normalizeRemoteReleaseArch(parsed?.arch),
      };
    },
    runRemoteText: async ({ ssh, remoteCommand, knownHostsMode }) => await runRemoteTextCapture(ssh, remoteCommand, knownHostsMode),
    copyLocalDirectoryToRemote: async ({ ssh, localPath, remotePath, knownHostsMode }) => await copyLocalDirectoryToRemoteCapture({ ssh, localPath, remotePath, knownHostsMode }),
    installRemoteComponent: async ({ componentId, channel, ssh, knownHostsMode, installerBinaryPath, remoteHomeDir }) => {
      const result = await installRemoteFirstPartyComponent({
        componentId,
        channel,
        ssh,
        knownHostsMode,
        installerBinaryPath,
        remoteHomeDir,
      });
      return {
        binaryPath: result.binaryPath,
        versionId: result.versionId,
      };
    },
    ...(params.localInstallPolicy ? { localInstallPolicy: params.localInstallPolicy } : {}),
    ...(params.resolveLocalInstallVersion ? { resolveLocalInstallVersion: params.resolveLocalInstallVersion } : {}),
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
