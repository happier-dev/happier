import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { link, mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import * as relayHost from '@happier-dev/cli-common/relayHost';
import * as systemTasks from '@happier-dev/cli-common/systemTasks';
import type {
  RemoteFirstPartyCommandResult,
  RemoteHostTrustResolution,
  SystemTaskSshConnectionConfig,
} from '@happier-dev/cli-common/systemTasks';
import { redactBugReportSensitiveText } from '@happier-dev/protocol/bugs/reports/redaction';
import { sanitizeBugReportArtifactPath } from '@happier-dev/protocol/bugs/reports/sanitize';
import type { SystemTaskJsonObject } from '@happier-dev/protocol';
import {
  resolvePublicReleaseRingIdForLabel,
  type PublicReleaseRingLabel,
} from '@happier-dev/release-runtime/releaseRings';

import { approveTerminalAuthRequest } from '@/auth/terminalAuthApproval';
import {
  parseCliDirectHomeQrTaskStreamEvent,
  presentCliDirectHomeQrInvite,
  type CliDirectHomeQrResult,
} from '@/auth/directHomeQr/runCliDirectHomeQr';
import { findAvailableLoopbackPort, isLoopbackPortAvailable } from '@/cloud/loopbackPort';
import { configuration, reloadConfiguration } from '@/configuration';
import { isLoopbackServerHost } from '@/server/serverUrlClassification';
import { createLivePersonalHomeOperations } from '../relayRuntime/liveRelayRuntime';

import { buildRemoteBootstrapCommand } from './remoteBootstrapCommandBuilder';
import {
  parseJsonLinesBestEffort,
  safeBashSingleQuote,
  type SshAuth,
} from './sshTransport';
import {
  buildSshKeyscanInvocation,
  readKnownHostsTextSyncWithFs,
  runOpenSshRemoteCommand,
  transferOpenSshFile,
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

async function runSshCommand(params: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
  auth: SshAuth;
  knownHostsPath?: string;
  knownHostsMode?: 'app' | 'system';
  remoteCommand: readonly string[];
  signal?: AbortSignal;
  timeoutMs?: number | null;
  onStdoutChunk?: (text: string) => void;
  includeStdoutInError?: boolean;
  input?: string;
}>): Promise<string> {
  if ((params.knownHostsMode ?? 'app') === 'app' && params.knownHostsPath) {
    mkdirSync(dirname(params.knownHostsPath), { recursive: true });
  }
  const invocation = {
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
    signal: params.signal,
    timeoutMs: params.timeoutMs,
    onStdoutChunk: params.onStdoutChunk,
    includeStdoutInError: params.includeStdoutInError,
    input: params.input,
  };
  // cli-common owns the nullable timeout contract. Its tracked declarations can
  // lag the current source during a shared package/CLI edit, so keep this
  // boundary assertion local while preserving `null` verbatim at runtime.
  const result = await runOpenSshRemoteCommand(
    invocation as Parameters<typeof runOpenSshRemoteCommand>[0],
  );
  return result.stdout;
}

async function runSshCommandResult(params: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
  auth: SshAuth;
  knownHostsPath?: string;
  knownHostsMode?: 'app' | 'system';
  remoteCommand: readonly string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  onStdoutChunk?: (text: string) => void;
  input?: string;
}>): Promise<RemoteCommandResult> {
  if ((params.knownHostsMode ?? 'app') === 'app' && params.knownHostsPath) {
    mkdirSync(dirname(params.knownHostsPath), { recursive: true });
  }
  return await runOpenSshRemoteCommand({
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
    signal: params.signal,
    timeoutMs: params.timeoutMs,
    onStdoutChunk: params.onStdoutChunk,
    input: params.input,
    rejectOnNonZero: false,
  });
}

async function runSshJson<T extends JsonRecord>(params: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
  auth: SshAuth;
  knownHostsPath?: string;
  knownHostsMode?: 'app' | 'system';
  remoteCommand: readonly string[];
  signal?: AbortSignal;
  timeoutMs?: number;
}>): Promise<T> {
  if ((params.knownHostsMode ?? 'app') === 'app' && params.knownHostsPath) {
    mkdirSync(dirname(params.knownHostsPath), { recursive: true });
  }
  const result = await runOpenSshRemoteCommand({
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
    signal: params.signal,
    timeoutMs: params.timeoutMs,
    rejectOnNonZero: false,
  });
  const stdout = result.stdout;
  const parsed = parseJsonLinesBestEffort<T>(stdout);
  if (parsed) {
    return parsed;
  }
  if (result.status === 0) {
    throw new Error('Remote command did not return valid JSON');
  }
  const stderr = result.stderr.trim();
  const detail = stderr || stdout.trim();
  const redactedDetail = detail ? redactSshStderrForErrorMessage(detail).trim() : '';
  throw new Error(
    redactedDetail
      ? `SSH command failed: ${redactedDetail}`
      : 'SSH command failed: remote command returned no JSON result',
  );
}

async function runSshPosixJson<T extends JsonRecord>(params: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
  auth: SshAuth;
  knownHostsPath?: string;
  knownHostsMode?: 'app' | 'system';
  shellCommand: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}>): Promise<T> {
  return await runSshJson<T>({
    ssh: params.ssh,
    auth: params.auth,
    knownHostsPath: params.knownHostsPath,
    knownHostsMode: params.knownHostsMode,
    remoteCommand: ['bash', '-lc', safeBashSingleQuote(params.shellCommand)],
    signal: params.signal,
    timeoutMs: params.timeoutMs,
  });
}

async function runSshPosixText(params: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
  auth: SshAuth;
  knownHostsPath?: string;
  knownHostsMode?: 'app' | 'system';
  shellCommand: string;
  signal?: AbortSignal;
  timeoutMs?: number | null;
  onStdoutChunk?: (text: string) => void;
  includeStdoutInError?: boolean;
  input?: string;
}>): Promise<RemoteFirstPartyCommandResult> {
  return {
    status: 0,
    stdout: await runSshCommand({
      ssh: params.ssh,
      auth: params.auth,
      knownHostsPath: params.knownHostsPath,
      knownHostsMode: params.knownHostsMode,
      remoteCommand: ['bash', '-lc', safeBashSingleQuote(params.shellCommand)],
      signal: params.signal,
      timeoutMs: params.timeoutMs,
      onStdoutChunk: params.onStdoutChunk,
      includeStdoutInError: params.includeStdoutInError,
      input: params.input,
    }),
    stderr: '',
  };
}

async function runSshPosixCommandResult(params: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
  auth: SshAuth;
  knownHostsPath?: string;
  knownHostsMode?: 'app' | 'system';
  shellCommand: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onStdoutChunk?: (text: string) => void;
  input?: string;
}>): Promise<RemoteCommandResult> {
  return await runSshCommandResult({
    ssh: params.ssh,
    auth: params.auth,
    knownHostsPath: params.knownHostsPath,
    knownHostsMode: params.knownHostsMode,
    remoteCommand: ['bash', '-lc', safeBashSingleQuote(params.shellCommand)],
    signal: params.signal,
    timeoutMs: params.timeoutMs,
    onStdoutChunk: params.onStdoutChunk,
    input: params.input,
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
  purpose?: Readonly<{ kind: 'personal-home'; canonicalServerUrl: string }>;
  signal?: AbortSignal;
}>): Promise<Readonly<{ relayUrl: string; mode: 'user' | 'system' }>> {
  const engineSsh = params.knownHostsMode === 'app' && params.knownHostsPath
    ? { ...params.ssh, knownHostsPath: params.knownHostsPath }
    : params.ssh;

  const engine = relayHost.createRelayHostEngine({
    resolveRemoteReleaseTarget: async ({ ssh, knownHostsMode }) => {
      const transportKnownHostsPath = knownHostsMode === 'app' ? params.knownHostsPath : undefined;
      const preflight = await runSshPosixJson<Readonly<{ platform?: unknown; arch?: unknown }>>({
        ssh,
        auth: params.auth,
        knownHostsPath: transportKnownHostsPath,
        knownHostsMode,
        shellCommand: [
          "printf '{\"platform\":\"%s\",\"arch\":\"%s\"}\\n'",
          '"$(uname -s | tr \'[:upper:]\' \'[:lower:]\')"',
          '"$(uname -m | tr \'[:upper:]\' \'[:lower:]\')"',
        ].join(' '),
        signal: params.signal,
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
        signal: params.signal,
      });
    },
    copyLocalDirectoryToRemote: async ({ ssh, localPath, remotePath, knownHostsMode }) => {
      const transportKnownHostsPath = knownHostsMode === 'app' ? params.knownHostsPath : undefined;
      await transferOpenSshFile({
        direction: 'upload', target: ssh.target, localPath, remotePath, recursive: true,
        sshConfigFile: ssh.sshConfigFile, knownHostsPath: transportKnownHostsPath, knownHostsMode,
        auth: params.auth, port: ssh.port, connectTimeoutSec: 10,
        serverAliveIntervalSec: 15, serverAliveCountMax: 2,
        ...(params.signal ? { signal: params.signal } : {}), timeoutMs: 15 * 60_000,
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
          const preflight = await runSshPosixJson<Readonly<{ platform?: unknown; arch?: unknown }>>({
            ssh,
            auth: params.auth,
            knownHostsPath: transportKnownHostsPath,
            knownHostsMode,
            shellCommand: [
              "printf '{\"platform\":\"%s\",\"arch\":\"%s\"}\\n'",
              '"$(uname -s | tr \'[:upper:]\' \'[:lower:]\')"',
              '"$(uname -m | tr \'[:upper:]\' \'[:lower:]\')"',
              ].join(' '),
              signal: params.signal,
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
          signal: params.signal,
        }),
        copyLocalDirectoryToRemote: async ({ localPath, remotePath }) => {
          await transferOpenSshFile({
            direction: 'upload', target: ssh.target, localPath, remotePath, recursive: true,
            sshConfigFile: ssh.sshConfigFile, knownHostsPath: transportKnownHostsPath, knownHostsMode,
            auth: params.auth, port: ssh.port, connectTimeoutSec: 10,
            serverAliveIntervalSec: 15, serverAliveCountMax: 2,
            ...(params.signal ? { signal: params.signal } : {}), timeoutMs: 15 * 60_000,
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
    ...(params.purpose ? { purpose: params.purpose } : {}),
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

async function resolveLiveRemoteHostTrust(params: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
  knownHostsMode: 'app' | 'system';
  signal?: AbortSignal;
}>): Promise<RemoteHostTrustResolution> {
  params.signal?.throwIfAborted();
  if (params.knownHostsMode === 'system') return { status: 'trusted' };
  const knownHostsPath = resolveKnownHostsPath(params.ssh, params.knownHostsMode);
  const existingKnownHostsText = readKnownHostsText(knownHostsPath);
  const parsedTarget = resolveSshEndpoint({ ssh: params.ssh });
  const keyscanOutput = runCommandSync({
    ...buildSshKeyscanInvocation({ host: parsedTarget.host, port: parsedTarget.port, timeoutSec: 5, keyType: 'ed25519' }),
    errorPrefix: 'ssh-keyscan failed',
  });
  params.signal?.throwIfAborted();
  const scanned = systemTasks.extractFirstScannedSshKnownHostLine(keyscanOutput);
  const normalizedHost = formatKnownHostsHostToken(parsedTarget);
  const scannedHostKeyLine = normalizedHost ? `${normalizedHost} ${scanned.keyType} ${scanned.key}` : scanned.line;
  const trust = systemTasks.resolveSshKnownHostTrust({
    knownHostsText: existingKnownHostsText,
    scannedHostKeyLine,
    trustedHostKey: params.ssh.trustedHostKey,
  });
  if (trust.status === 'rejected') {
    throw new systemTasks.SystemTaskExecutionError(
      trust.reason === 'invalidTrustedHostKey' ? 'invalid_trusted_host_key' : 'trusted_host_key_mismatch',
      trust.message,
    );
  }
  if (trust.status === 'trusted') {
    if (trust.nextKnownHostsText !== existingKnownHostsText) writeKnownHostsText(knownHostsPath, trust.nextKnownHostsText);
    return { status: 'trusted' };
  }
  return {
    status: 'prompt',
    promptKind: trust.promptKind,
    promptMessage: trust.promptKind === 'ssh.replaceHostKey' ? 'Replace the saved SSH host key?' : 'Trust this SSH host?',
    promptData: {
      host: trust.scanned.host,
      keyType: trust.scanned.keyType,
      fingerprint: trust.scanned.fingerprint,
      ...(trust.promptKind === 'ssh.replaceHostKey' ? { existingFingerprint: trust.existingFingerprint ?? null } : {}),
    },
    accept: async () => writeKnownHostsText(knownHostsPath, trust.nextKnownHostsText),
  };
}

async function installLiveRemoteCli(params: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
  auth: SshAuth;
  knownHostsMode: 'app' | 'system';
  channel: 'stable' | 'preview' | 'dev';
  signal?: AbortSignal;
}>): Promise<void> {
  const knownHostsPath = resolveKnownHostsPath(params.ssh, params.knownHostsMode);
  const localPayloadRootOverride = resolveLocalRemoteCliPayloadRootOverride();
  await systemTasks.installRemoteFirstPartyComponent({
    componentId: 'happier-cli', channel: params.channel, ssh: params.ssh, knownHostsMode: params.knownHostsMode,
    ...(params.signal ? { signal: params.signal } : {}),
  }, {
    ...(localPayloadRootOverride ? {
      preparePayload: async ({ componentId, channel }) => ({
        componentId, channel, versionId: `local-${params.channel}-${Date.now()}`,
        payloadRoot: localPayloadRootOverride, source: `local-payload:${localPayloadRootOverride}`, cleanup: async () => undefined,
      }),
    } : {}),
    resolveRemoteReleaseTarget: async ({ signal }) => {
      const preflight = await runSshPosixJson<Readonly<{ platform?: unknown; arch?: unknown }>>({
        ssh: params.ssh, auth: params.auth, knownHostsPath, knownHostsMode: params.knownHostsMode,
        shellCommand: ["printf '{\"platform\":\"%s\",\"arch\":\"%s\"}\\n'", '"$(uname -s | tr \'[:upper:]\' \'[:lower:]\')"', '"$(uname -m | tr \'[:upper:]\' \'[:lower:]\')"'].join(' '),
        signal,
      });
      return { os: systemTasks.normalizeRemoteReleaseOs(preflight.platform), arch: systemTasks.normalizeRemoteReleaseArch(preflight.arch) };
    },
    runRemoteText: async ({ remoteCommand, signal }) => runSshPosixText({
      ssh: params.ssh, auth: params.auth, knownHostsPath, knownHostsMode: params.knownHostsMode,
      shellCommand: remoteCommand, signal,
    }),
    copyLocalDirectoryToRemote: async ({ localPath, remotePath, signal }) => {
      await transferOpenSshFile({
        direction: 'upload', target: params.ssh.target, localPath, remotePath, recursive: true,
        sshConfigFile: params.ssh.sshConfigFile, knownHostsPath, knownHostsMode: params.knownHostsMode,
        auth: params.auth, port: params.ssh.port, connectTimeoutSec: 10,
        serverAliveIntervalSec: 15, serverAliveCountMax: 2,
        ...(signal ? { signal } : {}), timeoutMs: 15 * 60_000,
      });
    },
  });
}

export function createLiveRemoteSshManageHostTaskKind() {
  const runPersonalHomeCommand: NonNullable<systemTasks.RemoteSshManageHostDeps['runPersonalHomeCommand']> = async (commandParams) => {
    const { ssh, auth, knownHostsMode, channel, args, input, resultContract, signal } = commandParams;
    const timeoutMs = ('timeoutMs' in commandParams ? commandParams.timeoutMs : undefined) as
      Parameters<typeof runSshPosixText>[0]['timeoutMs'];
    const executor = systemTasks.createOpenSshHappierJsonExecutor({
      ssh,
      auth,
      knownHostsMode,
      channel: resolvePublicReleaseRingIdForLabel(channel),
      runRemoteText: async ({ remoteCommand, signal: commandSignal, timeoutMs, onStdoutChunk, includeStdoutInError, input: commandInput }) => await runSshPosixText({
        ssh, auth: auth as SshAuth, knownHostsPath: resolveKnownHostsPath(ssh, knownHostsMode), knownHostsMode,
        shellCommand: remoteCommand, signal: commandSignal, timeoutMs, onStdoutChunk, includeStdoutInError, input: commandInput,
      }),
    });
    const executionOptions = {
      signal,
      timeoutMs: timeoutMs === undefined ? 15 * 60_000 : timeoutMs,
      input,
    };
    const result = resultContract === 'task'
      ? systemTasks.parseStrictPersonalHomeTaskFinalResult((await executor.runHappierText(args, {
          ...executionOptions,
          includeStdoutInError: false,
        } as Parameters<typeof executor.runHappierText>[1])).stdout).data
      : await executor.runHappierJson(
          args,
          executionOptions as Parameters<typeof executor.runHappierJson>[1],
        );
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new systemTasks.SystemTaskExecutionError('invalid_cli_response', 'Remote Personal Home command returned invalid JSON.');
    }
    return result as SystemTaskJsonObject;
  };
  const transferPersonalHomeArchive: NonNullable<systemTasks.RemoteSshManageHostDeps['transferPersonalHomeArchive']> = async ({
    ssh, auth, knownHostsMode, direction, localPath, remotePath, signal,
  }) => {
    const transfer = async (transferLocalPath: string) => await transferOpenSshFile({
      direction,
      target: ssh.target,
      localPath: transferLocalPath,
      remotePath,
      sshConfigFile: ssh.sshConfigFile,
      knownHostsPath: resolveKnownHostsPath(ssh, knownHostsMode),
      knownHostsMode,
      auth: auth as SshAuth,
      port: ssh.port,
      connectTimeoutSec: 10,
      serverAliveIntervalSec: 15,
      serverAliveCountMax: 2,
      signal,
      timeoutMs: 15 * 60_000,
    });
    if (direction === 'upload') {
      await transfer(localPath);
      return;
    }
    const tempDirectory = await mkdtemp(join(dirname(localPath), '.happier-home-backup-'));
    const tempArchive = join(tempDirectory, basename(localPath));
    try {
      await transfer(tempArchive);
      await link(tempArchive, localPath);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  };
  return systemTasks.createRemoteSshManageHostTaskKind({
    resolveHostTrust: resolveLiveRemoteHostTrust,
    testConnection: async ({ ssh, auth, knownHostsMode, signal }) => {
      await runSshPosixText({
        ssh, auth: auth as SshAuth, knownHostsPath: resolveKnownHostsPath(ssh, knownHostsMode), knownHostsMode,
        shellCommand: 'true', timeoutMs: 15_000, signal,
      });
    },
    installRemoteCli: async ({ ssh, auth, knownHostsMode, channel, signal }) => await installLiveRemoteCli({
      ssh, auth: auth as SshAuth, knownHostsMode, channel, ...(signal ? { signal } : {}),
    }),
    runDaemonServiceCommand: async () => {
      throw new systemTasks.SystemTaskExecutionError('unsupported', 'Remote daemon management is not available through this coordinator yet.');
    },
    runRelayRuntimeCommand: async () => {
      throw new systemTasks.SystemTaskExecutionError('unsupported', 'Remote runtime management is not available through this coordinator yet.');
    },
    runPersonalHomeCommand,
    transferPersonalHomeArchive,
    runPersonalHomeRelocation: async (params) => {
      const source = await createLivePersonalHomeOperations({ channel: params.channel, mode: params.mode });
      const destination = systemTasks.createRemoteSshPersonalHomeRelocationDestination({
        ssh: params.ssh,
        auth: params.auth,
        knownHostsMode: params.knownHostsMode,
        channel: params.channel,
        mode: params.mode,
        runPersonalHomeCommand,
        transferPersonalHomeArchive,
        ensureRuntime: async (purpose, signal) => {
          await installRemoteRelayRuntimeUsingSharedEngine({
            ssh: params.ssh,
            auth: params.auth as SshAuth,
            knownHostsPath: resolveKnownHostsPath(params.ssh, params.knownHostsMode),
            knownHostsMode: params.knownHostsMode,
            channel: params.channel,
            mode: params.mode,
            purpose,
            ...(signal ? { signal } : {}),
          });
        },
      });
      const result = await source.relocate({
        operationId: params.operationId,
        sourceDescriptorRevision: params.sourceDescriptorRevision,
        destinationMachineId: params.destinationMachineId,
        ...(params.recoveryAction ? { recoveryAction: params.recoveryAction } : {}),
        destination,
        publishDestination: params.publishDestination,
        readPublishedDescriptor: params.readPublishedDescriptor,
        ...(params.signal ? { signal: params.signal } : {}),
        progress: params.progress,
      });
      return { ...result };
    },
    runPersonalHomePairDevice: async ({ ssh, auth, knownHostsMode, channel, homeServerIdentityId, args, signal }) => {
      const executor = systemTasks.createOpenSshHappierJsonExecutor({
        ssh,
        auth,
        knownHostsMode,
        channel: resolvePublicReleaseRingIdForLabel(channel),
        runRemoteText: async ({ remoteCommand, signal: commandSignal, timeoutMs, onStdoutChunk, includeStdoutInError }) => await runSshPosixText({
          ssh, auth: auth as SshAuth, knownHostsPath: resolveKnownHostsPath(ssh, knownHostsMode), knownHostsMode,
          shellCommand: remoteCommand, signal: commandSignal, timeoutMs, onStdoutChunk, includeStdoutInError,
        }),
      });
      let buffered = '';
      let result: CliDirectHomeQrResult | null = null;
      let invalidStream = false;
      const consumeLine = (line: string) => {
        if (!line.trim()) return;
        const event = parseCliDirectHomeQrTaskStreamEvent(line, Date.now(), homeServerIdentityId);
        if (!event || result) {
          invalidStream = true;
          return;
        }
        if (event.kind === 'home_pair_device.invite') {
          presentCliDirectHomeQrInvite({ link: event.link, copyLink: false });
          return;
        }
        result = event.result;
      };
      try {
        await executor.runHappierText(args, {
          signal,
          timeoutMs: 10 * 60_000,
          onStdoutChunk: (text) => {
            buffered += text;
            for (;;) {
              const newline = buffered.indexOf('\n');
              if (newline < 0) break;
              const line = buffered.slice(0, newline).replace(/\r$/u, '');
              buffered = buffered.slice(newline + 1);
              consumeLine(line);
            }
          },
          includeStdoutInError: false,
        });
        consumeLine(buffered.replace(/\r$/u, ''));
      } catch {
        return signal?.aborted ? { kind: 'cancelled' } : { kind: 'failed', status: 502 };
      }
      return invalidStream || !result ? { kind: 'failed', status: 502 } : result;
    },
    enrollInvokingClient: async ({ ssh, auth, knownHostsMode, channel, descriptor, signal }) => {
      const releaseRing = resolvePublicReleaseRingIdForLabel(channel);
      const localExecutor = systemTasks.createLocalHappierJsonExecutor({ releaseRing });
      const remoteExecutor = systemTasks.createOpenSshHappierJsonExecutor({
        ssh,
        auth,
        knownHostsMode,
        channel: releaseRing,
        runRemoteText: async ({ remoteCommand, signal: commandSignal, timeoutMs, onStdoutChunk, includeStdoutInError, input }) => await runSshPosixText({
          ssh,
          auth: auth as SshAuth,
          knownHostsPath: resolveKnownHostsPath(ssh, knownHostsMode),
          knownHostsMode,
          shellCommand: remoteCommand,
          signal: commandSignal,
          timeoutMs,
          onStdoutChunk,
          includeStdoutInError,
          input,
        }),
      });
      try {
        const enrolled = await systemTasks.runRemoteHomeEnrollmentRecipe({
          executor: localExecutor,
          homeTargetInput: {
            kind: 'descriptor',
            descriptor,
            authority: 'trusted_enrollment',
          },
          signal,
          timeoutMs: 10 * 60_000,
          approvePairingRequest: async (request) => {
            if (request.homeServerIdentityId !== descriptor.homeServerIdentityId) {
              throw new systemTasks.SystemTaskExecutionError(
                'home_identity_mismatch',
                'Remote enrollment request did not match the created Home identity.',
              );
            }
            await remoteExecutor.runHappierJson(
              ['auth', 'approve', '--public-key', request.publicKey, '--json', '--request-json-stdin'],
              {
                signal,
                timeoutMs: 2 * 60_000,
                input: JSON.stringify(request),
                includeStdoutInError: false,
              },
            );
          },
        });
        return enrolled.homeServerIdentityId === descriptor.homeServerIdentityId
          ? { kind: 'enrolled' }
          : { kind: 'failed' };
      } catch {
        return { kind: 'failed' };
      }
    },
  });
}

export function createLiveRemoteSshBootstrapTaskKind() {
  const baseKind = systemTasks.createRemoteSshBootstrapMachineTaskKind({
    resolveHostTrust: resolveLiveRemoteHostTrust,
    installRemoteCli: async ({ parsed, auth, knownHostsMode, signal }) => await installLiveRemoteCli({
      ssh: parsed.ssh, auth: auth as SshAuth, knownHostsMode, channel: parsed.channel ?? 'stable', signal,
    }),
    createRemoteEnrollmentExecutor: ({ parsed, auth, knownHostsMode, signal }) => createLiveRemoteEnrollmentExecutor({
      ssh: parsed.ssh,
      auth: auth as SshAuth,
      knownHostsMode,
      channel: parsed.channel ?? 'stable',
      signal,
    }),
    approveLocalAuthRequest: async ({ publicKey, pairing, supportsTokenOnly, parsed, signal }) => {
      const knownHostsMode = parsed.knownHostsMode ?? 'app';
      const knownHostsPath = resolveKnownHostsPath(parsed.ssh, knownHostsMode);
      // Forward the remote request's v3 pairing context verbatim so the
      // approval seals a pairing-secret-bound v3 response. The approval owner
      // is the single validator: absent, malformed, or expired context fails
      // closed there instead of degrading to an unbound legacy response. Only
      // the short-lived pairing context crosses this boundary — never the
      // claim secret or any persisted credential.
      const approvalRequest: Parameters<typeof approveTerminalAuthRequest>[0] = {
        publicKey,
        ...(pairing !== undefined && pairing !== null
          ? { pairing }
          : {}),
        ...(supportsTokenOnly === true ? { supportsTokenOnly: true } : {}),
        ...(signal ? { signal } : {}),
      };
      if (parsed.homeTarget?.descriptor) {
        await approveTerminalAuthRequest({
          ...approvalRequest,
          target: parsed.homeTarget,
        });
        return;
      }
      const loopbackPort = parseLoopbackPort(parsed.relay.relayUrl);
      if (loopbackPort) {
        const tunnelAuth = resolveSshAuthForTunnel(parsed.ssh);
        if (!tunnelAuth) {
          if (parsed.homeTarget) {
            throw new Error('The selected loopback Home requires an SSH local-forward capable authentication mode.');
          }
          await approveTerminalAuthRequest(approvalRequest);
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
              await approveTerminalAuthRequest(parsed.homeTarget
                ? {
                    ...approvalRequest,
                    target: {
                      ...parsed.homeTarget,
                      applicationUrl: `http://localhost:${localPort}`,
                      preferredTransport: 'https',
                    },
                  }
                : approvalRequest);
            });
          },
        });
        return;
      }

      if (parsed.homeTarget) {
        await approveTerminalAuthRequest({
          ...approvalRequest,
          target: parsed.homeTarget,
        });
        return;
      }

      await withEphemeralRelaySelection({
        relayUrl: parsed.relay.relayUrl,
        publicRelayUrl: parsed.relay.publicRelayUrl,
        webappUrl: parsed.relay.webappUrl,
        fn: async () => {
          await approveTerminalAuthRequest(approvalRequest);
        },
      });
    },
    runRemoteCommand: async ({ label, parsed, auth, knownHostsMode, data, signal }) => {
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
          signal,
        });
        return {
          ok: true,
          data: {
            relayUrl: relayInstall.relayUrl,
            mode: relayInstall.mode,
          },
        };
      }

      const result = await runSshPosixJson<JsonRecord>({
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
            data,
          });
        })(),
        signal,
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

export function createLiveRemoteEnrollmentExecutor(params: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
  auth: SshAuth;
  knownHostsMode: 'app' | 'system';
  channel?: PublicReleaseRingLabel;
  happierCommand?: string;
  signal?: AbortSignal;
}>): systemTasks.HappierJsonExecutor {
  return systemTasks.createOpenSshHappierJsonExecutor({
    ssh: params.ssh,
    auth: params.auth,
    knownHostsMode: params.knownHostsMode,
    channel: resolvePublicReleaseRingIdForLabel(params.channel ?? 'stable'),
    ...(params.happierCommand ? { happierCommand: params.happierCommand } : {}),
    runRemoteText: async ({
      remoteCommand,
      signal: commandSignal,
      timeoutMs,
      onStdoutChunk,
      includeStdoutInError,
      input,
    }) => await runSshPosixText({
      ssh: params.ssh,
      auth: params.auth,
      knownHostsPath: resolveKnownHostsPath(params.ssh, params.knownHostsMode),
      knownHostsMode: params.knownHostsMode,
      shellCommand: remoteCommand,
      signal: commandSignal ?? params.signal,
      timeoutMs,
      onStdoutChunk,
      includeStdoutInError,
      input,
    }),
  });
}
