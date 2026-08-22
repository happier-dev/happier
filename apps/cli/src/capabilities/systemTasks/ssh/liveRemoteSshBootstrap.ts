import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import * as relayHost from '@happier-dev/cli-common/relayHost';
import * as systemTasks from '@happier-dev/cli-common/systemTasks';
import type {
  RemoteFirstPartyCommandResult,
  RemoteHostTrustResolution,
  SystemTaskSshConnectionConfig,
} from '@happier-dev/cli-common/systemTasks';
import { redactBugReportSensitiveText, sanitizeBugReportArtifactPath } from '@happier-dev/protocol';

import { approveTerminalAuthRequest } from '@/auth/terminalAuthApproval';
import { findAvailableLoopbackPort, isLoopbackPortAvailable } from '@/cloud/loopbackPort';
import { configuration, reloadConfiguration } from '@/configuration';
import { isLoopbackServerHost } from '@/server/serverUrlClassification';

import { buildRemoteBootstrapCommand } from './remoteBootstrapCommandBuilder';
import {
  buildScpCommand,
  buildSshCommand,
  parseJsonLinesBestEffort,
  safeBashSingleQuote,
  type SshAuth,
} from './sshTransport';
import {
  buildSshKeyscanInvocation,
  readKnownHostsTextSyncWithFs,
  withOpenSshLocalPortForward,
  writeKnownHostsTextSyncWithFs,
  type OpenSshAuth,
} from '@happier-dev/cli-common/ssh';

type JsonRecord = Record<string, unknown>;
type RemoteCommandResult = Readonly<{ status: number; stdout: string; stderr: string }>;

const ABSOLUTE_PATH_TOKEN_PATTERN = /(^|[\s"'`=:(])((?:~\/|\/|[A-Za-z]:\\)[^\s"'`]+)/gu;
const LOCAL_REMOTE_CLI_PAYLOAD_ROOT_ENV = 'HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT';

function redactSshStderrForErrorMessage(raw: string): string {
  const base = redactBugReportSensitiveText(String(raw ?? ''));
  return base.replace(ABSOLUTE_PATH_TOKEN_PATTERN, (match, prefix: string, token: string) => {
    const sanitized = sanitizeBugReportArtifactPath(token);
    if (!sanitized) return match;
    return `${prefix}${sanitized}`;
  });
}

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
  return readKnownHostsTextSyncWithFs(knownHostsPath, { readFileSync });
}

function writeKnownHostsText(knownHostsPath: string | undefined, text: string): void {
  writeKnownHostsTextSyncWithFs(knownHostsPath, text, { mkdirSync, writeFileSync, chmodSync });
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

function formatKnownHostsHostToken(params: Readonly<{ host: string; port?: number }>): string {
  const host = String(params.host ?? '').trim();
  const port = params.port;
  if (!host) return host;
  if (!port || !Number.isFinite(port) || port <= 0 || port === 22) return host;
  return `[${host}]:${Math.floor(port)}`;
}

function parseLoopbackPort(url: string | undefined): number | null {
  const normalized = String(url ?? '').trim();
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    if (!isLoopbackServerHost(normalized)) return null;
    if (parsed.port) {
      const port = Number(parsed.port);
      if (Number.isFinite(port) && port > 0 && port <= 65535) return Math.floor(port);
    }
    if (parsed.protocol === 'https:') return 443;
    if (parsed.protocol === 'http:') return 80;
    return null;
  } catch {
    return null;
  }
}

function resolveSshAuthForTunnel(ssh: SystemTaskSshConnectionConfig): OpenSshAuth | null {
  if (ssh.auth === 'keyfile') {
    const identityFile = String(ssh.identityFile ?? '').trim();
    if (!identityFile) {
      return null;
    }
    return { mode: 'keyFile', privateKeyPath: identityFile };
  }
  if (ssh.auth === 'password') {
    return null;
  }
  return { mode: 'agent' };
}

type ServerSelectionEnvSnapshot = Readonly<{
  HAPPIER_SERVER_URL?: string;
  HAPPIER_PUBLIC_SERVER_URL?: string;
  HAPPIER_LOCAL_SERVER_URL?: string;
  HAPPIER_WEBAPP_URL?: string;
}>;

function snapshotServerSelectionEnv(): ServerSelectionEnvSnapshot {
  return {
    HAPPIER_SERVER_URL: process.env.HAPPIER_SERVER_URL,
    HAPPIER_PUBLIC_SERVER_URL: process.env.HAPPIER_PUBLIC_SERVER_URL,
    HAPPIER_LOCAL_SERVER_URL: process.env.HAPPIER_LOCAL_SERVER_URL,
    HAPPIER_WEBAPP_URL: process.env.HAPPIER_WEBAPP_URL,
  };
}

function restoreServerSelectionEnv(snapshot: ServerSelectionEnvSnapshot): void {
  const keys: Array<keyof ServerSelectionEnvSnapshot> = [
    'HAPPIER_SERVER_URL',
    'HAPPIER_PUBLIC_SERVER_URL',
    'HAPPIER_LOCAL_SERVER_URL',
    'HAPPIER_WEBAPP_URL',
  ];
  for (const key of keys) {
    const value = snapshot[key];
    if (typeof value === 'string') {
      process.env[key] = value;
    } else {
      delete process.env[key];
    }
  }
}

async function withEphemeralLoopbackServerSelection(
  params: Readonly<{
    port: number;
    fn: () => Promise<void>;
  }>,
): Promise<void> {
  const snapshot = snapshotServerSelectionEnv();
  try {
    const url = `http://localhost:${params.port}`;
    process.env.HAPPIER_SERVER_URL = url;
    process.env.HAPPIER_WEBAPP_URL = url;
    delete process.env.HAPPIER_PUBLIC_SERVER_URL;
    delete process.env.HAPPIER_LOCAL_SERVER_URL;
    reloadConfiguration();
    await params.fn();
  } finally {
    restoreServerSelectionEnv(snapshot);
    reloadConfiguration();
  }
}

async function withEphemeralRelaySelection(
  params: Readonly<{
    relayUrl: string;
    publicRelayUrl?: string;
    webappUrl?: string;
    fn: () => Promise<void>;
  }>,
): Promise<void> {
  const snapshot = snapshotServerSelectionEnv();
  try {
    const relayUrl = String(params.relayUrl ?? '').trim();
    const publicRelayUrl = String(params.publicRelayUrl ?? '').trim();
    const webappUrl = String(params.webappUrl ?? '').trim();

    const snapshotPublicRelayUrl = String(snapshot.HAPPIER_PUBLIC_SERVER_URL ?? '').trim();
    const snapshotLocalRelayUrl = String(snapshot.HAPPIER_LOCAL_SERVER_URL ?? '').trim();

    if (publicRelayUrl && publicRelayUrl !== relayUrl) {
      process.env.HAPPIER_PUBLIC_SERVER_URL = publicRelayUrl;
      process.env.HAPPIER_SERVER_URL = relayUrl;
      delete process.env.HAPPIER_LOCAL_SERVER_URL;
    } else if (
      snapshotPublicRelayUrl
      && snapshotLocalRelayUrl
      && relayUrl === snapshotPublicRelayUrl
    ) {
      process.env.HAPPIER_PUBLIC_SERVER_URL = snapshotPublicRelayUrl;
      process.env.HAPPIER_LOCAL_SERVER_URL = snapshotLocalRelayUrl;
      process.env.HAPPIER_SERVER_URL = snapshotLocalRelayUrl;
    } else {
      process.env.HAPPIER_SERVER_URL = relayUrl;
      delete process.env.HAPPIER_PUBLIC_SERVER_URL;
      delete process.env.HAPPIER_LOCAL_SERVER_URL;
    }

    if (webappUrl) {
      process.env.HAPPIER_WEBAPP_URL = webappUrl;
    } else {
      try {
        process.env.HAPPIER_WEBAPP_URL = new URL(relayUrl).origin;
      } catch {
        process.env.HAPPIER_WEBAPP_URL = relayUrl;
      }
    }

    reloadConfiguration();
    await params.fn();
  } finally {
    restoreServerSelectionEnv(snapshot);
    reloadConfiguration();
  }
}

function resolveSshEndpoint(params: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
}>): Readonly<{ host: string; port?: number }> {
  const parsedTarget = parseSshTarget(params.ssh.target);
  const explicitPort = typeof params.ssh.port === 'number' && Number.isFinite(params.ssh.port) && params.ssh.port > 0
    ? Math.floor(params.ssh.port)
    : undefined;
  const baselinePort = explicitPort ?? parsedTarget.port;
  const sshConfigFile = String(params.ssh.sshConfigFile ?? '').trim();
  if (!sshConfigFile) {
    return {
      host: parsedTarget.host,
      ...(typeof baselinePort === 'number' ? { port: baselinePort } : {}),
    };
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
    const redactedStderr = redactSshStderrForErrorMessage(stderr).trim();
    throw new Error(redactedStderr ? `SSH config resolution failed: ${redactedStderr}` : 'SSH config resolution failed');
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
    ...(explicitPort
      ? { port: explicitPort }
      : (Number.isFinite(resolvedPort) && resolvedPort > 0
          ? { port: Math.floor(resolvedPort) }
          : (typeof baselinePort === 'number' ? { port: baselinePort } : {}))),
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
    const stdout = String(result.stdout ?? '').trim();
    const detail = stderr || stdout;
    const redactedDetail = detail ? redactSshStderrForErrorMessage(detail).trim() : '';
    throw new Error(
      redactedDetail
        ? `${params.errorPrefix}: ${redactedDetail}`
        : `${params.errorPrefix}: ${params.redactedLabel ?? params.command}`,
    );
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

function runSshCommandResult(params: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
  auth: SshAuth;
  knownHostsPath?: string;
  knownHostsMode?: 'app' | 'system';
  remoteCommand: readonly string[];
}>): RemoteCommandResult {
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
  const result = spawnSync(invocation.command, [...invocation.args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  return {
    status: result.status ?? 1,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

function runSshJson<T extends JsonRecord>(params: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
  auth: SshAuth;
  knownHostsPath?: string;
  knownHostsMode?: 'app' | 'system';
  remoteCommand: readonly string[];
}>): T {
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
  const result = spawnSync(invocation.command, [...invocation.args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  const stdout = String(result.stdout ?? '');
  const parsed = parseJsonLinesBestEffort<T>(stdout);
  if (parsed) {
    return parsed;
  }
  if ((result.status ?? 1) === 0) {
    throw new Error('Remote command did not return valid JSON');
  }
  const stderr = String(result.stderr ?? '').trim();
  const detail = stderr || stdout.trim();
  const redactedDetail = detail ? redactSshStderrForErrorMessage(detail).trim() : '';
  throw new Error(
    redactedDetail
      ? `SSH command failed: ${redactedDetail}`
      : `SSH command failed: ${invocation.redactedLabel}`,
  );
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

function runSshPosixCommandResult(params: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
  auth: SshAuth;
  knownHostsPath?: string;
  knownHostsMode?: 'app' | 'system';
  shellCommand: string;
}>): RemoteCommandResult {
  return runSshCommandResult({
    ssh: params.ssh,
    auth: params.auth,
    knownHostsPath: params.knownHostsPath,
    knownHostsMode: params.knownHostsMode,
    remoteCommand: ['bash', '-lc', safeBashSingleQuote(params.shellCommand)],
  });
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

function applyRelayRuntimeUrlOverrides(params: Readonly<{
  relayUrl: string;
  envOverrides?: Record<string, string>;
}>): string {
  const rawHost = String(params.envOverrides?.HAPPIER_SERVER_HOST ?? '').trim();
  const rawPort = String(params.envOverrides?.PORT ?? '').trim();
  try {
    const url = new URL(params.relayUrl);
    if (rawHost) {
      url.hostname = rawHost;
    }
    const port = Number(rawPort);
    if (Number.isFinite(port) && port > 0) {
      url.port = String(Math.floor(port));
    }
    return url.toString().replace(/\/$/u, '');
  } catch {
    return params.relayUrl;
  }
}

async function installRemoteRelayRuntimeUsingSharedEngine(params: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
  auth: SshAuth;
  knownHostsPath?: string;
  knownHostsMode?: 'app' | 'system';
  channel?: 'stable' | 'preview' | 'dev';
  mode?: 'user' | 'system';
  env?: Record<string, string>;
  selfHostRelayBinaryOverride?: string;
}>): Promise<Readonly<{ relayUrl: string; mode: 'user' | 'system' }>> {
  const engineSsh = params.knownHostsMode === 'app' && params.knownHostsPath
    ? { ...params.ssh, knownHostsPath: params.knownHostsPath }
    : params.ssh;

  const engine = relayHost.createRelayHostEngine({
    resolveRemoteReleaseTarget: async ({ ssh, knownHostsMode }) => {
      const transportKnownHostsPath = knownHostsMode === 'app' ? params.knownHostsPath : undefined;
      const preflight = runSshPosixJson<Readonly<{ platform?: unknown; arch?: unknown }>>({
        ssh,
        auth: params.auth,
        knownHostsPath: transportKnownHostsPath,
        knownHostsMode,
        shellCommand: [
          "printf '{\"platform\":\"%s\",\"arch\":\"%s\"}\\n'",
          '"$(uname -s | tr \'[:upper:]\' \'[:lower:]\')"',
          '"$(uname -m | tr \'[:upper:]\' \'[:lower:]\')"',
        ].join(' '),
      });
      return {
        os: systemTasks.normalizeRemoteReleaseOs(preflight.platform),
        arch: systemTasks.normalizeRemoteReleaseArch(preflight.arch),
      };
    },
    runRemoteText: async ({ ssh, remoteCommand, knownHostsMode }) => {
      const transportKnownHostsPath = knownHostsMode === 'app' ? params.knownHostsPath : undefined;
      return runSshPosixCommandResult({
        ssh,
        auth: params.auth,
        knownHostsPath: transportKnownHostsPath,
        knownHostsMode,
        shellCommand: remoteCommand,
      });
    },
    copyLocalDirectoryToRemote: async ({ ssh, localPath, remotePath, knownHostsMode }) => {
      const transportKnownHostsPath = knownHostsMode === 'app' ? params.knownHostsPath : undefined;
      copyLocalDirectoryToRemote({
        ssh,
        auth: params.auth,
        knownHostsPath: transportKnownHostsPath,
        knownHostsMode,
        localPath,
        remotePath,
      });
    },
    installRemoteComponent: async ({ componentId, channel, ssh, knownHostsMode, installerBinaryPath, remoteHomeDir }) => {
      const transportKnownHostsPath = knownHostsMode === 'app' ? params.knownHostsPath : undefined;
      const installed = await systemTasks.installRemoteFirstPartyComponent({
        componentId,
        channel,
        ssh,
        knownHostsMode,
        installerBinaryPath,
        remoteHomeDir,
      }, {
        resolveRemoteReleaseTarget: async () => {
          const preflight = runSshPosixJson<Readonly<{ platform?: unknown; arch?: unknown }>>({
            ssh,
            auth: params.auth,
            knownHostsPath: transportKnownHostsPath,
            knownHostsMode,
            shellCommand: [
              "printf '{\"platform\":\"%s\",\"arch\":\"%s\"}\\n'",
              '"$(uname -s | tr \'[:upper:]\' \'[:lower:]\')"',
              '"$(uname -m | tr \'[:upper:]\' \'[:lower:]\')"',
            ].join(' '),
          });
          return {
            os: systemTasks.normalizeRemoteReleaseOs(preflight.platform),
            arch: systemTasks.normalizeRemoteReleaseArch(preflight.arch),
          };
        },
        runRemoteText: async ({ remoteCommand }) => runSshPosixText({
          ssh,
          auth: params.auth,
          knownHostsPath: transportKnownHostsPath,
          knownHostsMode,
          shellCommand: remoteCommand,
        }),
        copyLocalDirectoryToRemote: async ({ localPath, remotePath }) => {
          copyLocalDirectoryToRemote({
            ssh,
            auth: params.auth,
            knownHostsPath: transportKnownHostsPath,
            knownHostsMode,
            localPath,
            remotePath,
          });
        },
      });
      return {
        binaryPath: installed.binaryPath,
        versionId: installed.versionId,
      };
    },
  });

  const installResult = await engine.installOrUpdate({
    target: { kind: 'ssh', ssh: engineSsh },
    channel: params.channel,
    mode: params.mode,
    env: params.env,
    selfHostRelayBinaryOverride: params.selfHostRelayBinaryOverride,
  });

  return {
    relayUrl: applyRelayRuntimeUrlOverrides({
      relayUrl: installResult.relayUrl,
      envOverrides: params.env,
    }),
    mode: installResult.mode,
  };
}

function resolveLocalRemoteCliPayloadRootOverride(): string | null {
  const raw = String(process.env[LOCAL_REMOTE_CLI_PAYLOAD_ROOT_ENV] ?? '').trim();
  return raw ? raw : null;
}

export function createLiveRemoteSshBootstrapTaskKind() {
  const baseKind = systemTasks.createRemoteSshBootstrapMachineTaskKind({
    resolveHostTrust: async ({ ssh, knownHostsMode }): Promise<RemoteHostTrustResolution> => {
      if (knownHostsMode === 'system') {
        return { status: 'trusted' };
      }

      const knownHostsPath = resolveKnownHostsPath(ssh, knownHostsMode);
      const existingKnownHostsText = readKnownHostsText(knownHostsPath);
      const parsedTarget = resolveSshEndpoint({ ssh });
      const keyscanInvocation = buildSshKeyscanInvocation({
        host: parsedTarget.host,
        port: parsedTarget.port,
        timeoutSec: 5,
        keyType: 'ed25519',
      });
      const keyscanOutput = runCommandSync({
        ...keyscanInvocation,
        errorPrefix: 'ssh-keyscan failed',
      });
      const scanned = systemTasks.extractFirstScannedSshKnownHostLine(keyscanOutput);
      const normalizedScannedHostKeyLine = (() => {
        const normalizedHost = formatKnownHostsHostToken(parsedTarget);
        if (!normalizedHost) return scanned.line;
        return `${normalizedHost} ${scanned.keyType} ${scanned.key}`;
      })();
      const trust = systemTasks.resolveSshKnownHostTrust({
        knownHostsText: existingKnownHostsText,
        scannedHostKeyLine: normalizedScannedHostKeyLine,
        trustedHostKey: ssh.trustedHostKey,
      });

      if (trust.status === 'rejected') {
        throw new systemTasks.SystemTaskExecutionError(
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
      const localPayloadRootOverride = resolveLocalRemoteCliPayloadRootOverride();
      await systemTasks.installRemoteFirstPartyComponent({
        componentId: 'happier-cli',
        channel: parsed.channel,
        ssh: parsed.ssh,
        knownHostsMode,
      }, {
        ...(localPayloadRootOverride
          ? {
              preparePayload: async ({ componentId, channel }) => ({
                componentId,
                channel,
                versionId: `local-${parsed.channel ?? 'unknown'}-${Date.now()}`,
                payloadRoot: localPayloadRootOverride,
                source: `local-payload:${localPayloadRootOverride}`,
                cleanup: async () => undefined,
              }),
            }
          : {}),
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
            os: systemTasks.normalizeRemoteReleaseOs(preflight.platform),
            arch: systemTasks.normalizeRemoteReleaseArch(preflight.arch),
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
    approveLocalAuthRequest: async ({ publicKey, parsed }) => {
      const knownHostsMode = parsed.knownHostsMode ?? 'app';
      const knownHostsPath = resolveKnownHostsPath(parsed.ssh, knownHostsMode);
      const loopbackPort = parseLoopbackPort(parsed.relay.relayUrl);
      if (loopbackPort) {
        const tunnelAuth = resolveSshAuthForTunnel(parsed.ssh);
        if (!tunnelAuth) {
          await approveTerminalAuthRequest({ publicKey });
          return;
        }
        const requestedPort = Number(loopbackPort);
        const localPort = (await isLoopbackPortAvailable(requestedPort))
          ? requestedPort
          : await findAvailableLoopbackPort();
        await withEphemeralLoopbackServerSelection({
          port: localPort,
          fn: async () => {
            await withOpenSshLocalPortForward({
              sshBin: 'ssh',
              target: parsed.ssh.target,
              port: parsed.ssh.port,
              sshConfigFile: parsed.ssh.sshConfigFile,
              auth: tunnelAuth,
              knownHostsPath,
              knownHostsMode,
              localPort,
              remotePort: requestedPort,
              connectTimeoutSec: 10,
              serverAliveIntervalSec: 15,
              serverAliveCountMax: 2,
            }, async () => {
              await approveTerminalAuthRequest({ publicKey });
            });
          },
        });
        return;
      }

      await withEphemeralRelaySelection({
        relayUrl: parsed.relay.relayUrl,
        publicRelayUrl: parsed.relay.publicRelayUrl,
        webappUrl: parsed.relay.webappUrl,
        fn: async () => {
          await approveTerminalAuthRequest({ publicKey });
        },
      });
    },
    runRemoteCommand: async ({ label, parsed, auth, knownHostsMode, data }) => {
      const knownHostsPath = resolveKnownHostsPath(parsed.ssh, knownHostsMode);

      if (label === 'relay.runtime.install') {
        const relayInstall = await installRemoteRelayRuntimeUsingSharedEngine({
          ssh: parsed.ssh,
          auth: auth as SshAuth,
          knownHostsPath,
          knownHostsMode,
          channel: parsed.channel,
          mode: parsed.relayRuntime?.mode ?? 'user',
          env: parsed.relayRuntime?.env,
          selfHostRelayBinaryOverride: parsed.relayRuntime?.selfHostRelayBinaryOverride,
        });
        return {
          ok: true,
          data: {
            relayUrl: relayInstall.relayUrl,
            mode: relayInstall.mode,
          },
        };
      }

      const result = runSshPosixJson<JsonRecord>({
        ssh: parsed.ssh,
        auth: auth as SshAuth,
        knownHostsPath,
        knownHostsMode,
        shellCommand: (() => {
          const localServerUrl = typeof data?.localServerUrl === 'string' ? data.localServerUrl.trim() : '';
          return buildRemoteBootstrapCommand({
            label,
            channel: parsed.channel,
            serverUrl: parsed.relay.relayUrl,
            localServerUrl: localServerUrl || undefined,
            webappUrl: parsed.relay.webappUrl && isLoopbackServerHost(parsed.relay.webappUrl)
              ? undefined
              : parsed.relay.webappUrl,
            daemonServiceMode: parsed.serviceMode,
            data: label === 'auth.wait'
              ? { publicKey: data?.publicKey }
              : undefined,
          });
        })(),
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
