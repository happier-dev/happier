import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import chalk from 'chalk';

import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';

import {
  prepareFirstPartyComponentPayloadFromGitHubRelease,
  resolveRelayRuntimeDefaults,
} from '@happier-dev/cli-common/firstPartyRuntime';
import { resolveServiceBackend } from '@happier-dev/cli-common/service';
import { createRelayHostEngine } from '@happier-dev/cli-common/relayHost';
import {
  installRemoteFirstPartyComponent,
  type RelayRuntimeStatusSnapshot,
  type RelayRuntimeTaskParams,
  type SystemTaskSshConnectionConfig,
} from '@happier-dev/cli-common/systemTasks';

type RelayHostStatusJson = Readonly<{
  installed: boolean;
  version: string | null;
  service: RelayRuntimeStatusSnapshot['service'];
  relayUrl: string;
  healthy: boolean | null;
}>;

type RelayHostInstallJson = Readonly<{
  relayUrl: string;
  mode: 'user' | 'system';
}>;

const TEST_FIRST_PARTY_PAYLOAD_ROOT_ENV = 'HAPPIER_TEST_FIRST_PARTY_PAYLOAD_ROOT';
const TEST_FIRST_PARTY_PAYLOAD_VERSION_ID_ENV = 'HAPPIER_TEST_FIRST_PARTY_PAYLOAD_VERSION_ID';

function takeFlag(args: string[], name: string): { present: boolean; rest: string[] } {
  const rest: string[] = [];
  let present = false;
  for (const arg of args) {
    if (arg === name) {
      present = true;
      continue;
    }
    rest.push(arg);
  }
  return { present, rest };
}

function takeFlagValue(args: string[], name: string): { value: string | null; rest: string[] } {
  const rest: string[] = [];
  let value: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const current = String(args[index] ?? '');
    if (current === name) {
      const next = String(args[index + 1] ?? '');
      if (!next) {
        throw new Error(`Missing value for ${name}`);
      }
      value = next;
      index += 1;
      continue;
    }
    if (current.startsWith(`${name}=`)) {
      value = current.slice(`${name}=`.length);
      continue;
    }
    rest.push(current);
  }

  return { value, rest };
}

function normalizeMode(raw: unknown): 'user' | 'system' {
  return String(raw ?? '').trim().toLowerCase() === 'system' ? 'system' : 'user';
}

function normalizeChannel(raw: unknown): 'stable' | 'preview' | 'dev' {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === 'preview') return 'preview';
  if (value === 'dev') return 'dev';
  return 'stable';
}

function resolveTestFirstPartyPayloadOverride(): Readonly<{ payloadRoot: string; versionId: string }> | null {
  const payloadRoot = String(process.env[TEST_FIRST_PARTY_PAYLOAD_ROOT_ENV] ?? '').trim();
  if (!payloadRoot) return null;
  const versionId = String(process.env[TEST_FIRST_PARTY_PAYLOAD_VERSION_ID_ENV] ?? '').trim() || 'test';
  if (!existsSync(payloadRoot)) {
    throw new Error(`Invalid ${TEST_FIRST_PARTY_PAYLOAD_ROOT_ENV}: path does not exist`);
  }
  if (!lstatSync(payloadRoot).isDirectory()) {
    throw new Error(`Invalid ${TEST_FIRST_PARTY_PAYLOAD_ROOT_ENV}: expected a directory`);
  }
  return { payloadRoot, versionId };
}

function quoteForRemoteBash(command: string): string {
  const raw = String(command ?? '');
  if (!raw) return "''";
  return `'${raw.replaceAll("'", `'\"'\"'`)}'`;
}

function buildSshArgs(params: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
  knownHostsMode: 'app' | 'system';
  remoteCommand: string;
}>): string[] {
  const args: string[] = [];

  if (typeof params.ssh.port === 'number') {
    args.push('-p', String(Math.floor(params.ssh.port)));
  }
  if (params.ssh.sshConfigFile) {
    args.push('-F', params.ssh.sshConfigFile);
  }

  args.push(
    '-o',
    'BatchMode=yes',
    '-o',
    'LogLevel=ERROR',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
  );

  if (params.knownHostsMode === 'app') {
    if (!params.ssh.knownHostsPath) {
      throw new Error('knownHostsPath is required when using app-managed known hosts');
    }
    args.push(
      '-o',
      'GlobalKnownHostsFile=/dev/null',
      '-o',
      `UserKnownHostsFile=${params.ssh.knownHostsPath}`,
    );
  }

  args.push(
    '-o',
    'StrictHostKeyChecking=yes',
  );

  if (params.ssh.auth === 'keyfile') {
    if (!params.ssh.identityFile) {
      throw new Error('identityFile is required for keyfile auth');
    }
    args.push('-i', params.ssh.identityFile);
  }

  args.push(params.ssh.target, 'bash', '-lc', quoteForRemoteBash(params.remoteCommand));
  return args;
}

function buildScpArgs(params: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
  knownHostsMode: 'app' | 'system';
  localPath: string;
  remotePath: string;
}>): string[] {
  const args: string[] = [];

  if (typeof params.ssh.port === 'number') {
    args.push('-P', String(Math.floor(params.ssh.port)));
  }
  if (params.ssh.sshConfigFile) {
    args.push('-F', params.ssh.sshConfigFile);
  }

  args.push(
    '-o',
    'BatchMode=yes',
    '-o',
    'LogLevel=ERROR',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
  );

  if (params.knownHostsMode === 'app') {
    if (!params.ssh.knownHostsPath) {
      throw new Error('knownHostsPath is required when using app-managed known hosts');
    }
    args.push(
      '-o',
      'GlobalKnownHostsFile=/dev/null',
      '-o',
      `UserKnownHostsFile=${params.ssh.knownHostsPath}`,
    );
  }

  args.push(
    '-o',
    'StrictHostKeyChecking=yes',
  );

  if (params.ssh.auth === 'keyfile') {
    if (!params.ssh.identityFile) {
      throw new Error('identityFile is required for keyfile auth');
    }
    args.push('-i', params.ssh.identityFile);
  }

  args.push('-r', params.localPath, `${params.ssh.target}:${params.remotePath}`);
  return args;
}

function resolveKnownHostsMode(ssh: SystemTaskSshConnectionConfig): 'app' | 'system' {
  return ssh.knownHostsPath ? 'app' : 'system';
}

function runCommandCapture(command: string, args: readonly string[]): Readonly<{ status: number; stdout: string; stderr: string }> {
  const out = spawnSync(command, [...args], { encoding: 'utf8' });
  return {
    status: typeof out.status === 'number' ? out.status : 1,
    stdout: String(out.stdout ?? ''),
    stderr: String(out.stderr ?? out.error?.message ?? ''),
  };
}

function buildSshRunner(ssh: SystemTaskSshConnectionConfig) {
  const knownHostsMode = resolveKnownHostsMode(ssh);
  return {
    knownHostsMode,
    runRemoteText: async (remoteCommand: string) => {
      return runCommandCapture('ssh', buildSshArgs({ ssh, knownHostsMode, remoteCommand }));
    },
    copyLocalDirectoryToRemote: async (localPath: string, remotePath: string) => {
      const result = runCommandCapture('scp', buildScpArgs({ ssh, knownHostsMode, localPath, remotePath }));
      if (result.status !== 0) {
        throw new Error(result.stderr.trim() || 'SCP failed');
      }
    },
  };
}

function createMemoizedResolveRemoteReleaseTarget(runner: ReturnType<typeof buildSshRunner>) {
  let cached: Readonly<{ os: 'linux' | 'darwin'; arch: 'x64' | 'arm64' }> | null = null;
  return async () => {
    if (cached) return cached;
    const result = await runner.runRemoteText([
      "printf '{\"platform\":\"%s\",\"arch\":\"%s\"}\\n'",
      '"$(uname -s | tr \'[:upper:]\' \'[:lower:]\')"',
      '"$(uname -m | tr \'[:upper:]\' \'[:lower:]\')"',
    ].join(' '));
    const parsed = JSON.parse(result.stdout || '{}') as { platform?: unknown; arch?: unknown };
    cached = {
      os: String(parsed.platform ?? '').includes('darwin') ? 'darwin' : 'linux',
      arch: String(parsed.arch ?? '').includes('arm') ? 'arm64' : 'x64',
    };
    return cached;
  };
}

async function readLocalStatus(params: Readonly<{ channel: 'stable' | 'preview' | 'dev'; mode: 'user' | 'system' }>): Promise<RelayHostStatusJson> {
  const releaseChannel = params.channel === 'dev' ? 'publicdev' : params.channel;
  const defaults = resolveRelayRuntimeDefaults({
    platform: process.platform,
    mode: params.mode,
    channel: releaseChannel,
    homeDir: homedir(),
  });
  const statePath = join(defaults.installRoot, 'self-host-state.json');
  const binaryName = process.platform === 'win32' ? 'happier-server.exe' : 'happier-server';
  const binaryPath = join(defaults.installRoot, 'bin', binaryName);
  const stateText = existsSync(statePath) ? await readFile(statePath, 'utf8').catch(() => '') : '';
  const state = stateText.trim() ? (JSON.parse(stateText) as { version?: string | null }) : null;
  const version = typeof state?.version === 'string' ? state.version : null;

  const backend = resolveServiceBackend({ platform: process.platform, mode: params.mode });
  const service = await queryLocalService({ backend, serviceName: defaults.serviceName });
  const installed = Boolean(version) || existsSync(binaryPath);

  return {
    installed,
    version,
    service,
    relayUrl: `http://${defaults.serverHost}:${defaults.serverPort}`,
    healthy: null,
  };
}

async function queryLocalService(params: Readonly<{ backend: string; serviceName: string }>): Promise<RelayRuntimeStatusSnapshot['service']> {
  if (params.backend === 'systemd-user' || params.backend === 'systemd-system') {
    const prefix = params.backend === 'systemd-user' ? ['--user'] : [];
    const result = runCommandCapture('systemctl', [...prefix, 'show', `${params.serviceName}.service`, '--property=UnitFileState,ActiveState,SubState', '--value']);
    const [unitFileState = '', activeState = ''] = result.stdout.split(/\r?\n/);
    return {
      enabled: unitFileState.trim().toLowerCase() === 'enabled',
      active: activeState.trim().toLowerCase() === 'active',
    };
  }

  if (params.backend === 'launchd-user' || params.backend === 'launchd-system') {
    const result = runCommandCapture('launchctl', ['list', params.serviceName]);
    const loaded = result.status === 0;
    return { enabled: loaded, active: loaded };
  }

  if (params.backend === 'schtasks-user' || params.backend === 'schtasks-system') {
    const result = runCommandCapture('schtasks', ['/Query', '/TN', `Happier\\${params.serviceName}`, '/FO', 'LIST', '/V']);
    const output = `${result.stdout}\n${result.stderr}`;
    const exists = result.status === 0;
    return {
      enabled: exists && /Scheduled Task State:\s*Enabled/i.test(output),
      active: exists && /Status:\s*Running/i.test(output),
    };
  }

  return { enabled: null, active: null };
}

async function controlLocalService(params: Readonly<{ channel: 'stable' | 'preview' | 'dev'; mode: 'user' | 'system'; action: 'start' | 'stop' | 'restart' }>): Promise<void> {
  const releaseChannel = params.channel === 'dev' ? 'publicdev' : params.channel;
  const defaults = resolveRelayRuntimeDefaults({
    platform: process.platform,
    mode: params.mode,
    channel: releaseChannel,
    homeDir: homedir(),
  });
  const backend = resolveServiceBackend({ platform: process.platform, mode: params.mode });
  const serviceName = defaults.serviceName;

  const command = (() => {
    if (backend === 'systemd-user') return { cmd: 'systemctl', args: ['--user', params.action, `${serviceName}.service`] };
    if (backend === 'systemd-system') return { cmd: 'systemctl', args: [params.action, `${serviceName}.service`] };
    if (backend === 'launchd-user' || backend === 'launchd-system') {
      const domain = `gui/${process.getuid?.() ?? 0}/${serviceName}`;
      return {
        cmd: 'launchctl',
        args: params.action === 'stop'
          ? ['bootout', domain]
          : ['kickstart', '-k', domain],
      };
    }
    return {
      cmd: 'schtasks',
      args: params.action === 'stop'
        ? ['/End', '/TN', `Happier\\${serviceName}`]
        : ['/Run', '/TN', `Happier\\${serviceName}`],
    };
  })();

  const result = runCommandCapture(command.cmd, command.args);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `Failed to ${params.action} relay service`);
  }
}

function resolveRelayRuntimeTaskParams(params: Readonly<{
  channel: 'stable' | 'preview' | 'dev';
  mode: 'user' | 'system';
  ssh: SystemTaskSshConnectionConfig | null;
}>): RelayRuntimeTaskParams {
  return {
    target: params.ssh ? { kind: 'ssh', ssh: params.ssh } : { kind: 'local' },
    channel: params.channel,
    mode: params.mode,
  };
}

export async function runRelayHostSubcommand(args: string[]): Promise<void> {
  const json = wantsJson(args);
  const op = String(args[0] ?? '').trim();
  if (!op) {
    throw new Error('Usage: happier relay host <install|status|start|stop|restart> [--ssh <user@host>] [--mode user|system] [--channel stable|preview|dev] [--json]');
  }

  let rest = args.slice(1);
  const channelFlag = takeFlagValue(rest, '--channel');
  rest = channelFlag.rest;
  const modeFlag = takeFlagValue(rest, '--mode');
  rest = modeFlag.rest;
  const sshFlag = takeFlagValue(rest, '--ssh');
  rest = sshFlag.rest;
  const identityFile = takeFlagValue(rest, '--identity-file');
  rest = identityFile.rest;
  const sshConfigFile = takeFlagValue(rest, '--ssh-config-file');
  rest = sshConfigFile.rest;
  const knownHostsPath = takeFlagValue(rest, '--known-hosts-path');
  rest = knownHostsPath.rest;
  const trustedHostKey = takeFlagValue(rest, '--trusted-host-key');
  rest = trustedHostKey.rest;
  const port = takeFlagValue(rest, '--port');
  rest = port.rest;
  const jsonFlag = takeFlag(rest, '--json');
  rest = jsonFlag.rest;

  if (rest.length > 0) {
    throw new Error(`Unknown relay host arguments: ${rest.join(' ')}`);
  }

  const channel = normalizeChannel(channelFlag.value);
  const mode = normalizeMode(modeFlag.value);

  const ssh: SystemTaskSshConnectionConfig | null = sshFlag.value
    ? {
        target: sshFlag.value.trim(),
        auth: identityFile.value?.trim() ? 'keyfile' : 'agent',
        ...(identityFile.value?.trim() ? { identityFile: identityFile.value.trim() } : {}),
        ...(sshConfigFile.value?.trim() ? { sshConfigFile: sshConfigFile.value.trim() } : {}),
        ...(knownHostsPath.value?.trim() ? { knownHostsPath: knownHostsPath.value.trim() } : {}),
        ...(trustedHostKey.value?.trim() ? { trustedHostKey: trustedHostKey.value.trim() } : {}),
        ...(port.value && Number.isFinite(Number(port.value)) ? { port: Number(port.value) } : {}),
      }
    : null;

  if (ssh && !ssh.target) {
    throw new Error('Missing required flag: --ssh <user@host>');
  }

  const taskParams = resolveRelayRuntimeTaskParams({ channel, mode, ssh });

  if (op === 'status') {
    const payload = ssh
      ? (() => {
          const runner = buildSshRunner(ssh);
          const resolveRemoteReleaseTarget = createMemoizedResolveRemoteReleaseTarget(runner);
          const engine = createRelayHostEngine({
            resolveRemoteReleaseTarget: async () => await resolveRemoteReleaseTarget(),
            runRemoteText: async ({ remoteCommand }) => await runner.runRemoteText(remoteCommand),
            copyLocalDirectoryToRemote: async ({ localPath, remotePath }) => {
              await runner.copyLocalDirectoryToRemote(localPath, remotePath);
            },
            installRemoteComponent: async () => {
              throw new Error('Remote component installation is not required for status');
            },
          });
          return engine.readStatus(taskParams as RelayRuntimeTaskParams).then((status) => ({
            installed: status.installed,
            version: status.version,
            service: status.service,
            relayUrl: status.baseUrl,
            healthy: status.healthy,
          }));
        })()
      : readLocalStatus({ channel, mode });

    const status = await payload;

    if (json) {
      printJsonEnvelope({
        ok: true,
        kind: 'relay_host_status',
        data: status,
      });
      return;
    }

    console.log(chalk.bold('Relay host status'));
    console.log(chalk.gray(`  url: ${status.relayUrl}`));
    console.log(chalk.gray(`  installed: ${status.installed ? 'yes' : 'no'}`));
    if (status.version) console.log(chalk.gray(`  version: ${status.version}`));
    console.log(chalk.gray(`  service: ${status.service.active ? 'running' : 'stopped'}`));
    return;
  }

  if (op === 'install') {
    const result = ssh
      ? (() => {
          const runner = buildSshRunner(ssh);
          const resolveRemoteReleaseTarget = createMemoizedResolveRemoteReleaseTarget(runner);
          const override = resolveTestFirstPartyPayloadOverride();
          const engine = createRelayHostEngine({
            resolveRemoteReleaseTarget: async () => await resolveRemoteReleaseTarget(),
            runRemoteText: async ({ remoteCommand }) => await runner.runRemoteText(remoteCommand),
            copyLocalDirectoryToRemote: async ({ localPath, remotePath }) => {
              await runner.copyLocalDirectoryToRemote(localPath, remotePath);
            },
            installRemoteComponent: async ({ componentId, channel, ssh, knownHostsMode, installerBinaryPath, remoteHomeDir }) => {
              const out = await installRemoteFirstPartyComponent({
                componentId,
                channel,
                ssh,
                knownHostsMode,
                installerBinaryPath,
                remoteHomeDir,
              }, {
                resolveRemoteReleaseTarget: async () => await resolveRemoteReleaseTarget(),
                runRemoteText: async ({ remoteCommand }) => await runner.runRemoteText(remoteCommand),
                copyLocalDirectoryToRemote: async ({ localPath, remotePath }) => {
                  await runner.copyLocalDirectoryToRemote(localPath, remotePath);
                },
                preparePayload: async (payloadParams) => {
                  if (override) {
                    return {
                      componentId: payloadParams.componentId,
                      channel: payloadParams.channel,
                      versionId: override.versionId,
                      payloadRoot: override.payloadRoot,
                      source: null,
                      cleanup: async () => undefined,
                    };
                  }
                  return await prepareFirstPartyComponentPayloadFromGitHubRelease(payloadParams);
                },
              });
              return { binaryPath: out.binaryPath, versionId: out.versionId };
            },
          });
          return engine.installOrUpdate(taskParams);
        })()
      : (() => {
          throw new Error('Local relay host install is not implemented in this command surface yet.');
        })();

    const payload: RelayHostInstallJson = await result;

    if (json) {
      printJsonEnvelope({
        ok: true,
        kind: 'relay_host_install',
        data: payload,
      });
      return;
    }

    console.log(chalk.green('✓ Relay host installed'));
    console.log(chalk.gray(`  ${payload.relayUrl}`));
    return;
  }

  if (op === 'start' || op === 'stop' || op === 'restart') {
    if (ssh) {
      const runner = buildSshRunner(ssh);
      const resolveRemoteReleaseTarget = createMemoizedResolveRemoteReleaseTarget(runner);
      const engine = createRelayHostEngine({
        resolveRemoteReleaseTarget: async () => await resolveRemoteReleaseTarget(),
        runRemoteText: async ({ remoteCommand }) => await runner.runRemoteText(remoteCommand),
        copyLocalDirectoryToRemote: async ({ localPath, remotePath }) => {
          await runner.copyLocalDirectoryToRemote(localPath, remotePath);
        },
        installRemoteComponent: async () => {
          throw new Error('Remote component installation is not required for control');
        },
      });
      await engine.control({ ...taskParams, action: op });
    } else {
      await controlLocalService({ channel, mode, action: op });
    }

    if (json) {
      printJsonEnvelope({
        ok: true,
        kind: `relay_host_${op}`,
        data: { ok: true },
      });
      return;
    }

    console.log(chalk.green(`✓ Relay host ${op} requested`));
    return;
  }

  throw new Error(`Unknown relay host subcommand: ${op}`);
}
