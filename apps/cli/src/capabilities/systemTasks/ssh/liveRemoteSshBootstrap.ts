import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  createRemoteSshBootstrapMachineTaskKind,
  extractFirstScannedSshKnownHostLine,
  installRemoteFirstPartyComponent,
  normalizeRemoteReleaseArch,
  normalizeRemoteReleaseOs,
  resolveRemoteInstalledFirstPartyBinaryPath,
  resolveSshKnownHostTrust,
  SystemTaskExecutionError,
  type RemoteFirstPartyCommandResult,
  type RemoteHostTrustResolution,
  type SystemTaskSshConnectionConfig,
} from '@happier-dev/cli-common/systemTasks';
import { normalizePublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import { approveTerminalAuthRequest } from '@/auth/terminalAuthApproval';
import { configuration } from '@/configuration';

import { buildRemoteBootstrapCommand } from './remoteBootstrapCommandBuilder';
import {
  buildScpCommand,
  buildSshCommand,
  parseJsonLinesBestEffort,
  safeBashSingleQuote,
  type SshAuth,
} from './sshTransport';

type JsonRecord = Record<string, unknown>;

function resolveAppKnownHostsPath(): string {
  return join(configuration.happyHomeDir, 'ssh', 'known_hosts');
}

function resolveKnownHostsPath(
  ssh: SystemTaskSshConnectionConfig,
  knownHostsMode: 'app' | 'system',
): string | undefined {
  if (knownHostsMode === 'system') {
    return undefined;
  }
  return String(ssh.knownHostsPath ?? '').trim() || resolveAppKnownHostsPath();
}

function readKnownHostsText(knownHostsPath: string | undefined): string {
  if (!knownHostsPath) {
    return '';
  }
  try {
    return readFileSync(knownHostsPath, 'utf8');
  } catch {
    return '';
  }
}

function writeKnownHostsText(knownHostsPath: string | undefined, text: string): void {
  if (!knownHostsPath) {
    return;
  }
  mkdirSync(dirname(knownHostsPath), { recursive: true });
  writeFileSync(knownHostsPath, text ? `${text}\n` : '', 'utf8');
}

function parseSshTarget(target: string): Readonly<{ host: string; port?: number }> {
  const raw = String(target ?? '').trim();
  const withoutUser = raw.includes('@') ? raw.slice(raw.lastIndexOf('@') + 1) : raw;
  const bracketMatch = /^\[(.+)\](?::(\d+))?$/u.exec(withoutUser);
  if (bracketMatch) {
    return {
      host: bracketMatch[1],
      ...(bracketMatch[2] ? { port: Number(bracketMatch[2]) } : {}),
    };
  }
  const colonParts = withoutUser.split(':');
  if (colonParts.length === 2 && /^\d+$/u.test(colonParts[1] ?? '')) {
    return {
      host: colonParts[0] ?? withoutUser,
      port: Number(colonParts[1]),
    };
  }
  return { host: withoutUser };
}

function resolveSshEndpoint(params: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
}>): Readonly<{ host: string; port?: number }> {
  const parsedTarget = parseSshTarget(params.ssh.target);
  const sshConfigFile = String(params.ssh.sshConfigFile ?? '').trim();
  if (!sshConfigFile) {
    return parsedTarget;
  }

  const result = spawnSync('ssh', ['-G', '-F', sshConfigFile, params.ssh.target], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    const stderr = String(result.stderr ?? '').trim();
    throw new Error(stderr ? `SSH config resolution failed: ${stderr}` : 'SSH config resolution failed');
  }

  const values = new Map<string, string>();
  for (const line of String(result.stdout ?? '').split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const splitIndex = trimmed.indexOf(' ');
    if (splitIndex < 0) continue;
    const key = trimmed.slice(0, splitIndex).trim().toLowerCase();
    const value = trimmed.slice(splitIndex + 1).trim();
    if (key && value) {
      values.set(key, value);
    }
  }

  const resolvedPort = Number(values.get('port') ?? '');
  return {
    host: values.get('hostname')?.trim() || parsedTarget.host,
    ...(Number.isFinite(resolvedPort) && resolvedPort > 0
      ? { port: Math.floor(resolvedPort) }
      : (typeof parsedTarget.port === 'number' ? { port: parsedTarget.port } : {})),
  };
}

function runCommandSync(params: Readonly<{
  command: string;
  args: readonly string[];
  errorPrefix: string;
  redactedLabel?: string;
}>): string {
  const result = spawnSync(params.command, [...params.args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    const stderr = String(result.stderr ?? '').trim();
    throw new Error(stderr ? `${params.errorPrefix}: ${stderr}` : `${params.errorPrefix}: ${params.redactedLabel ?? params.command}`);
  }
  return String(result.stdout ?? '');
}

function runSshCommand(params: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
  auth: SshAuth;
  knownHostsPath?: string;
  knownHostsMode?: 'app' | 'system';
  remoteCommand: readonly string[];
}>): string {
  if ((params.knownHostsMode ?? 'app') === 'app' && params.knownHostsPath) {
    mkdirSync(dirname(params.knownHostsPath), { recursive: true });
  }
  const invocation = buildSshCommand({
    sshBin: 'ssh',
    target: params.ssh.target,
    port: params.ssh.port,
    sshConfigFile: params.ssh.sshConfigFile,
    remoteCommand: params.remoteCommand,
    knownHostsPath: params.knownHostsPath,
    knownHostsMode: params.knownHostsMode,
    auth: params.auth,
    connectTimeoutSec: 10,
    serverAliveIntervalSec: 15,
    serverAliveCountMax: 2,
  });
  return runCommandSync({
    command: invocation.command,
    args: invocation.args,
    errorPrefix: 'SSH command failed',
    redactedLabel: invocation.redactedLabel,
  });
}

function runSshJson<T extends JsonRecord>(params: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
  auth: SshAuth;
  knownHostsPath?: string;
  knownHostsMode?: 'app' | 'system';
  remoteCommand: readonly string[];
}>): T {
  const parsed = parseJsonLinesBestEffort<T>(
    runSshCommand({
      ssh: params.ssh,
      auth: params.auth,
      knownHostsPath: params.knownHostsPath,
      knownHostsMode: params.knownHostsMode,
      remoteCommand: params.remoteCommand,
    }),
  );
  if (!parsed) {
    throw new Error('Remote command did not return valid JSON');
  }
  return parsed;
}

function runSshPosixJson<T extends JsonRecord>(params: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
  auth: SshAuth;
  knownHostsPath?: string;
  knownHostsMode?: 'app' | 'system';
  shellCommand: string;
}>): T {
  return runSshJson<T>({
    ssh: params.ssh,
    auth: params.auth,
    knownHostsPath: params.knownHostsPath,
    knownHostsMode: params.knownHostsMode,
    remoteCommand: ['bash', '-lc', safeBashSingleQuote(params.shellCommand)],
  });
}

function runSshPosixText(params: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
  auth: SshAuth;
  knownHostsPath?: string;
  knownHostsMode?: 'app' | 'system';
  shellCommand: string;
}>): RemoteFirstPartyCommandResult {
  return {
    status: 0,
    stdout: runSshCommand({
      ssh: params.ssh,
      auth: params.auth,
      knownHostsPath: params.knownHostsPath,
      knownHostsMode: params.knownHostsMode,
      remoteCommand: ['bash', '-lc', safeBashSingleQuote(params.shellCommand)],
    }),
    stderr: '',
  };
}

function copyLocalDirectoryToRemote(params: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
  auth: SshAuth;
  knownHostsPath?: string;
  knownHostsMode?: 'app' | 'system';
  localPath: string;
  remotePath: string;
}>): void {
  const invocation = buildScpCommand({
    scpBin: 'scp',
    target: params.ssh.target,
    port: params.ssh.port,
    sshConfigFile: params.ssh.sshConfigFile,
    localPath: params.localPath,
    remotePath: params.remotePath,
    knownHostsPath: params.knownHostsPath,
    knownHostsMode: params.knownHostsMode,
    auth: params.auth,
    connectTimeoutSec: 10,
    serverAliveIntervalSec: 15,
    serverAliveCountMax: 2,
  });
  runCommandSync({
    command: invocation.command,
    args: invocation.args,
    errorPrefix: 'SCP command failed',
    redactedLabel: invocation.redactedLabel,
  });
}

function normalizeRelayRuntimeCommandChannel(raw: unknown): 'stable' | 'preview' | 'dev' {
  const channel = normalizePublicReleaseRingId(String(raw ?? '').trim());
  if (channel === 'preview') {
    return 'preview';
  }
  if (channel === 'publicdev') {
    return 'dev';
  }
  return 'stable';
}

function buildRelayRuntimeInstallCommand(params: Readonly<{
  remoteHstackBinaryPath: string;
  channel?: string;
  mode?: 'user' | 'system';
  env?: Record<string, string>;
  selfHostRelayBinaryOverride?: string;
}>): string {
  const mode = params.mode === 'system' ? 'system' : 'user';
  const args = [
    params.remoteHstackBinaryPath,
    'self-host',
    'install',
    `--channel=${normalizeRelayRuntimeCommandChannel(params.channel)}`,
    `--mode=${mode}`,
    '--non-interactive',
    '--json',
    ...(params.selfHostRelayBinaryOverride
      ? ['--self-host-server-binary', params.selfHostRelayBinaryOverride]
      : []),
    ...Object.entries(params.env ?? {}).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
  ];
  return args
    .map((value, index) => index === 0 || value.startsWith('$HOME/') ? value : safeBashSingleQuote(value))
    .join(' ');
}

export function createLiveRemoteSshBootstrapTaskKind() {
  const baseKind = createRemoteSshBootstrapMachineTaskKind({
    resolveHostTrust: async ({ ssh, knownHostsMode }): Promise<RemoteHostTrustResolution> => {
      if (knownHostsMode === 'system') {
        return { status: 'trusted' };
      }

      const knownHostsPath = resolveKnownHostsPath(ssh, knownHostsMode);
      const existingKnownHostsText = readKnownHostsText(knownHostsPath);
      const parsedTarget = resolveSshEndpoint({ ssh });
      const keyscanOutput = runCommandSync({
        command: 'ssh-keyscan',
        args: [
          '-T',
          '5',
          ...(parsedTarget.port ? ['-p', String(parsedTarget.port)] : []),
          '-t',
          'ed25519',
          parsedTarget.host,
        ],
        errorPrefix: 'ssh-keyscan failed',
      });
      const scanned = extractFirstScannedSshKnownHostLine(keyscanOutput);
      const trust = resolveSshKnownHostTrust({
        knownHostsText: existingKnownHostsText,
        scannedHostKeyLine: scanned.line,
        trustedHostKey: ssh.trustedHostKey,
      });

      if (trust.status === 'rejected') {
        throw new SystemTaskExecutionError(
          trust.reason === 'invalidTrustedHostKey'
            ? 'invalid_trusted_host_key'
            : 'trusted_host_key_mismatch',
          trust.message,
        );
      }

      if (trust.status === 'trusted') {
        if (trust.nextKnownHostsText !== existingKnownHostsText) {
          writeKnownHostsText(knownHostsPath, trust.nextKnownHostsText);
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
          writeKnownHostsText(knownHostsPath, trust.nextKnownHostsText);
        },
      };
    },
    installRemoteCli: async ({ parsed, auth, knownHostsMode }) => {
      const knownHostsPath = resolveKnownHostsPath(parsed.ssh, knownHostsMode);
      await installRemoteFirstPartyComponent({
        componentId: 'happier-cli',
        channel: parsed.channel,
        ssh: parsed.ssh,
        knownHostsMode,
      }, {
        resolveRemoteReleaseTarget: async () => {
          const preflight = runSshPosixJson<Readonly<{ platform?: unknown; arch?: unknown }>>({
            ssh: parsed.ssh,
            auth: auth as SshAuth,
            knownHostsPath,
            knownHostsMode,
            shellCommand: [
              "printf '{\"platform\":\"%s\",\"arch\":\"%s\"}\\n'",
              '"$(uname -s | tr \'[:upper:]\' \'[:lower:]\')"',
              '"$(uname -m | tr \'[:upper:]\' \'[:lower:]\')"',
            ].join(' '),
          });
          return {
            os: normalizeRemoteReleaseOs(preflight.platform),
            arch: normalizeRemoteReleaseArch(preflight.arch),
          };
        },
        runRemoteText: async ({ remoteCommand }) => runSshPosixText({
          ssh: parsed.ssh,
          auth: auth as SshAuth,
          knownHostsPath,
          knownHostsMode,
          shellCommand: remoteCommand,
        }),
        copyLocalDirectoryToRemote: async ({ localPath, remotePath }) => {
          copyLocalDirectoryToRemote({
            ssh: parsed.ssh,
            auth: auth as SshAuth,
            knownHostsPath,
            knownHostsMode,
            localPath,
            remotePath,
          });
        },
      });
    },
    approveLocalAuthRequest: async ({ publicKey }) => {
      await approveTerminalAuthRequest({ publicKey });
    },
    runRemoteCommand: async ({ label, parsed, auth, knownHostsMode, data }) => {
      const knownHostsPath = resolveKnownHostsPath(parsed.ssh, knownHostsMode);

      if (label === 'relay.runtime.install') {
        const remoteCliBinaryPath = resolveRemoteInstalledFirstPartyBinaryPath({
          componentId: 'happier-cli',
          channel: parsed.channel,
        });
        const remoteHstack = await installRemoteFirstPartyComponent({
          componentId: 'hstack',
          channel: parsed.channel,
          ssh: parsed.ssh,
          knownHostsMode,
          installerBinaryPath: remoteCliBinaryPath,
        }, {
          resolveRemoteReleaseTarget: async () => {
            const preflight = runSshPosixJson<Readonly<{ platform?: unknown; arch?: unknown }>>({
              ssh: parsed.ssh,
              auth: auth as SshAuth,
              knownHostsPath,
              knownHostsMode,
              shellCommand: [
                "printf '{\"platform\":\"%s\",\"arch\":\"%s\"}\\n'",
                '"$(uname -s | tr \'[:upper:]\' \'[:lower:]\')"',
                '"$(uname -m | tr \'[:upper:]\' \'[:lower:]\')"',
              ].join(' '),
            });
            return {
              os: normalizeRemoteReleaseOs(preflight.platform),
              arch: normalizeRemoteReleaseArch(preflight.arch),
            };
          },
          runRemoteText: async ({ remoteCommand }) => runSshPosixText({
            ssh: parsed.ssh,
            auth: auth as SshAuth,
            knownHostsPath,
            knownHostsMode,
            shellCommand: remoteCommand,
          }),
          copyLocalDirectoryToRemote: async ({ localPath, remotePath }) => {
            copyLocalDirectoryToRemote({
              ssh: parsed.ssh,
              auth: auth as SshAuth,
              knownHostsPath,
              knownHostsMode,
              localPath,
              remotePath,
            });
          },
        });
        const relayInstall = runSshPosixJson<Readonly<{ serverUrl?: string | null }>>({
          ssh: parsed.ssh,
          auth: auth as SshAuth,
          knownHostsPath,
          knownHostsMode,
          shellCommand: buildRelayRuntimeInstallCommand({
            remoteHstackBinaryPath: remoteHstack.binaryPath,
            channel: parsed.channel,
            mode: parsed.relayRuntime?.mode ?? 'user',
            env: parsed.relayRuntime?.env,
            selfHostRelayBinaryOverride: parsed.relayRuntime?.selfHostRelayBinaryOverride,
          }),
        });
        return {
          ok: true,
          data: {
            relayUrl: String(relayInstall.serverUrl ?? '').trim() || 'http://127.0.0.1:3005',
            mode: parsed.relayRuntime?.mode === 'system' ? 'system' : 'user',
          },
        };
      }

      const result = runSshPosixJson<JsonRecord>({
        ssh: parsed.ssh,
        auth: auth as SshAuth,
        knownHostsPath,
        knownHostsMode,
        shellCommand: buildRemoteBootstrapCommand({
          label,
          channel: parsed.channel,
          serverUrl: parsed.relay.relayUrl,
          webappUrl: parsed.relay.webappUrl,
          publicServerUrl: parsed.relay.publicRelayUrl,
          daemonServiceMode: parsed.serviceMode,
          data: label === 'auth.wait'
            ? { publicKey: data?.publicKey }
            : undefined,
        }),
      });
      if (label === 'auth.status') {
        if (result.ok === false) {
          return {
            ok: true,
            data: { authenticated: false },
          };
        }
        if (typeof result.data === 'object' && result.data != null) {
          return {
            ok: true,
            data: result.data as JsonRecord,
          };
        }
      }
      if (typeof result.data === 'object' && result.data != null) {
        return {
          ok: result.ok !== false,
          data: result.data as JsonRecord,
        };
      }
      return {
        ok: result.ok !== false,
        data: result,
      };
    },
  });

  return {
    async run(ctx: Parameters<typeof baseKind.run>[0]) {
      return await baseKind.run(ctx);
    },
  };
}
