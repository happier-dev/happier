import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { inferPublicReleaseRingIdFromEnvAndArgv } from '@/cli/runtime/publicReleaseChannel';
import { createOutputBuilder, ok } from '@happier-dev/cli-common/output';
import { isInteractiveTerminal, promptInput } from '@/terminal/prompts/promptInput';
import { promptSecret } from '@/terminal/prompts/promptSecret';
import { ensureSshAskpassScriptPath, SSH_PASSWORD_ENV } from '@/capabilities/systemTasks/ssh/sshAskpass';

import { readKnownHostsTextSync, sshKeyscanSync, writeKnownHostsTextSync } from '@happier-dev/cli-common/ssh';

import {
  prepareFirstPartyComponentPayloadFromGitHubRelease,
} from '@happier-dev/cli-common/firstPartyRuntime';
import { createRelayHostEngine } from '@happier-dev/cli-common/relayHost';
import {
  installRemoteFirstPartyComponent,
  normalizeRemoteReleaseArch,
  normalizeRemoteReleaseOs,
  buildSshTarget,
  parseSshTarget,
  extractFirstScannedSshKnownHostLine,
  resolveSshKnownHostTrust,
  type RelayRuntimeStatusSnapshot,
  type RelayRuntimeTaskParams,
  type SystemTaskSshConnectionConfig,
} from '@happier-dev/cli-common/systemTasks';
import { normalizePublicReleaseRingLabel } from '@happier-dev/release-runtime/releaseRings';

type RelayHostStatusJson = Readonly<{
  installed: boolean;
  version: string | null;
  service: RelayRuntimeStatusSnapshot['service'];
  relayUrl: string | null;
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

function takeRepeatedFlagValues(args: string[], name: string): { values: string[]; rest: string[] } {
  const rest: string[] = [];
  const values: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const current = String(args[index] ?? '');
    if (current === name) {
      const next = String(args[index + 1] ?? '');
      if (!next || next.startsWith('--')) {
        throw new Error(`Missing value for ${name}`);
      }
      values.push(next);
      index += 1;
      continue;
    }
    if (current.startsWith(`${name}=`)) {
      const next = current.slice(`${name}=`.length);
      if (!next) {
        throw new Error(`Missing value for ${name}`);
      }
      values.push(next);
      continue;
    }
    rest.push(current);
  }

  return { values, rest };
}

function parseEnvOverrides(values: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of values) {
    const entry = String(raw ?? '').trim();
    if (!entry) continue;
    if (/[\r\n\0]/.test(entry)) {
      throw new Error('Invalid --env value: keys and values must be single-line.');
    }
    const eq = entry.indexOf('=');
    if (eq < 0) {
      throw new Error(`Invalid --env value (expected KEY=VALUE): ${entry}`);
    }
    const key = entry.slice(0, eq).trim();
    const value = entry.slice(eq + 1);
    if (!key) {
      throw new Error(`Invalid --env value (expected KEY=VALUE): ${entry}`);
    }
    if (/[\r\n\0]/.test(key) || /[\r\n\0]/.test(value)) {
      throw new Error('Invalid --env value: keys and values must be single-line.');
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid --env value: unsupported key "${key}".`);
    }
    env[key] = value;
  }
  return env;
}

function normalizeMode(raw: unknown): 'user' | 'system' {
  return String(raw ?? '').trim().toLowerCase() === 'system' ? 'system' : 'user';
}

function normalizeChannel(raw: unknown): 'stable' | 'preview' | 'dev' {
  const explicit = String(raw ?? '').trim();
  if (explicit) {
    return normalizePublicReleaseRingLabel(explicit) || 'stable';
  }
  const inferred = inferPublicReleaseRingIdFromEnvAndArgv({
    env: process.env,
    argv: process.argv,
    argv0: process.argv0,
    execPath: process.execPath,
  });
  return inferred === 'publicdev' ? 'dev' : inferred;
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

function resolveFirstExistingPath(candidates: readonly string[]): string {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (existsSync(candidate)) {
        return candidate;
      }
    } catch {
      continue;
    }
  }
  return '';
}

function resolveLocalServerBinaryFromPayloadRoot(payloadRoot: string): string {
  const root = String(payloadRoot ?? '').trim();
  if (!root) return '';
  const name = process.platform === 'win32' ? 'happier-server.exe' : 'happier-server';
  return resolveFirstExistingPath([
    join(root, name),
    join(root, 'bin', name),
  ]);
}

function resolveLocalServerPayloadOverrideFromBinaryPath(serverBinaryPath: string): Readonly<{
  payloadRoot: string;
  versionId: string;
}> {
  const binaryPath = String(serverBinaryPath ?? '').trim();
  if (!binaryPath || !existsSync(binaryPath)) {
    throw new Error(`server binary not found: ${binaryPath || '(empty)'}`);
  }
  const binaryDir = dirname(binaryPath);
  const payloadRoot = basename(binaryDir) === 'bin'
    ? dirname(binaryDir)
    : binaryDir;
  if (!existsSync(payloadRoot) || !lstatSync(payloadRoot).isDirectory()) {
    throw new Error(`server payload root not found: ${payloadRoot}`);
  }
  return {
    payloadRoot,
    versionId: basename(payloadRoot) || 'local-server',
  };
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
    params.ssh.auth === 'password' ? 'BatchMode=no' : 'BatchMode=yes',
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
  if (params.ssh.auth === 'password') {
    args.push(
      '-o',
      'NumberOfPasswordPrompts=1',
      '-o',
      'PreferredAuthentications=password,keyboard-interactive',
    );
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
    params.ssh.auth === 'password' ? 'BatchMode=no' : 'BatchMode=yes',
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
  if (params.ssh.auth === 'password') {
    args.push(
      '-o',
      'NumberOfPasswordPrompts=1',
      '-o',
      'PreferredAuthentications=password,keyboard-interactive',
    );
  }

  args.push('-r', params.localPath, `${params.ssh.target}:${params.remotePath}`);
  return args;
}

function resolveKnownHostsMode(ssh: SystemTaskSshConnectionConfig): 'app' | 'system' {
  return ssh.knownHostsPath ? 'app' : 'system';
}

function formatSshHostTrustMessage(params: Readonly<{
  promptKind: 'ssh.trustHost' | 'ssh.replaceHostKey';
  host: string;
  keyType: string;
  fingerprint: string;
  existingFingerprint?: string;
}>): string {
  return [
    params.promptKind === 'ssh.replaceHostKey' ? 'SSH host key has changed.' : 'Trust remote SSH host key?',
    params.host ? `Host: ${params.host}` : '',
    params.keyType ? `Key type: ${params.keyType}` : '',
    params.fingerprint ? `Fingerprint: ${params.fingerprint}` : '',
    params.existingFingerprint ? `Existing fingerprint: ${params.existingFingerprint}` : '',
  ].filter(Boolean).join('\n');
}

function runCommandCapture(
  command: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Readonly<{ status: number; stdout: string; stderr: string }> {
  const out = spawnSync(command, [...args], { encoding: 'utf8', ...(env ? { env } : {}) });
  return {
    status: typeof out.status === 'number' ? out.status : 1,
    stdout: String(out.stdout ?? ''),
    stderr: String(out.stderr ?? out.error?.message ?? ''),
  };
}

function resolveSshEndpointForKeyscan(params: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
}>): Readonly<{ host: string; port?: number }> {
  const parsedTarget = parseSshTarget(params.ssh.target);
  const explicitPort = typeof params.ssh.port === 'number' && Number.isFinite(params.ssh.port) && params.ssh.port > 0
    ? Math.floor(params.ssh.port)
    : undefined;
  const baselinePort = explicitPort;

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
    const stdout = String(result.stdout ?? '').trim();
    const detail = stderr || stdout;
    throw new Error(detail ? `SSH config resolution failed: ${detail}` : 'SSH config resolution failed');
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

function buildSshRunner(
  ssh: SystemTaskSshConnectionConfig,
  password: string | null,
  params: Readonly<{
    assumeYes: boolean;
    interactive: boolean;
    promptInput: (prompt: string) => Promise<string>;
  }>,
) {
  const knownHostsMode = resolveKnownHostsMode(ssh);
  const ensureTrustedHostKey = () => {
    if (knownHostsMode !== 'app') return;
    if (!ssh.knownHostsPath || !ssh.trustedHostKey) return;
    const trustedHostKey = String(ssh.trustedHostKey).trim();
    if (!trustedHostKey) return;
    if (trustedHostKey.includes('\n') || trustedHostKey.includes('\r')) {
      throw new Error('Invalid --trusted-host-key: expected a single known_hosts line');
    }

    mkdirSync(dirname(ssh.knownHostsPath), { recursive: true });
    let existing = '';
    try {
      existing = readFileSync(ssh.knownHostsPath, 'utf8');
    } catch {
      existing = '';
    }
    if (existing.includes(trustedHostKey)) return;
    const suffix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    writeFileSync(ssh.knownHostsPath, `${existing}${suffix}${trustedHostKey}\n`, 'utf8');
  };

  const ensureHostTrusted = (() => {
    let resolved = false;
    return async () => {
      if (resolved) return;
      if (knownHostsMode !== 'app') {
        resolved = true;
        return;
      }
      if (!ssh.knownHostsPath) {
        throw new Error('knownHostsPath is required when using app-managed known hosts');
      }
      // If the caller supplied an explicit trusted host key, preserve the legacy behavior: write it
      // and let OpenSSH validate it (no extra keyscan required).
      if (ssh.trustedHostKey) {
        ensureTrustedHostKey();
        resolved = true;
        return;
      }

      const parsedTarget = parseSshTarget(ssh.target);
      const host = parsedTarget.host.trim();
      if (!host) {
        throw new Error('Missing required SSH host.');
      }

      const endpoint = resolveSshEndpointForKeyscan({ ssh });
      const scannedOutput = sshKeyscanSync({
        host: endpoint.host,
        ...(typeof endpoint.port === 'number' ? { port: endpoint.port } : {}),
        timeoutSec: 10,
      });
      const scanned = extractFirstScannedSshKnownHostLine(scannedOutput);
      const trust = resolveSshKnownHostTrust({
        knownHostsText: readKnownHostsTextSync(ssh.knownHostsPath),
        scannedHostKeyLine: scanned.line,
      });

      if (trust.status === 'rejected') {
        throw new Error(trust.message);
      }

      if (trust.status === 'prompt') {
        const message = formatSshHostTrustMessage({
          promptKind: trust.promptKind,
          host: trust.scanned.host,
          keyType: trust.scanned.keyType,
          fingerprint: trust.scanned.fingerprint,
          ...(trust.existingFingerprint ? { existingFingerprint: trust.existingFingerprint } : {}),
        });

        if (!params.assumeYes) {
          if (!params.interactive) {
            throw new Error('Non-interactive mode requires --yes for SSH host trust prompts.');
          }
          const answer = await params.promptInput(`${message}\nTrust this host key? [y/N]: `);
          if (!/^y(?:es)?$/i.test(answer.trim())) {
            throw new Error('SSH host trust was declined.');
          }
        }

        writeKnownHostsTextSync(ssh.knownHostsPath, trust.nextKnownHostsText);
        resolved = true;
        return;
      }

      // Trusted (either unchanged or already present).
      writeKnownHostsTextSync(ssh.knownHostsPath, trust.nextKnownHostsText);
      resolved = true;
    };
  })();

  return {
    knownHostsMode,
    runRemoteText: async (remoteCommand: string) => {
      await ensureHostTrusted();
      const env = ssh.auth === 'password'
        ? {
            ...process.env,
            [SSH_PASSWORD_ENV]: String(password ?? ''),
            SSH_ASKPASS: ensureSshAskpassScriptPath(),
            SSH_ASKPASS_REQUIRE: 'force',
            DISPLAY: process.env.DISPLAY ?? ':0',
          }
        : undefined;
      return runCommandCapture('ssh', buildSshArgs({ ssh, knownHostsMode, remoteCommand }), env);
    },
    copyLocalDirectoryToRemote: async (localPath: string, remotePath: string) => {
      await ensureHostTrusted();
      const env = ssh.auth === 'password'
        ? {
            ...process.env,
            [SSH_PASSWORD_ENV]: String(password ?? ''),
            SSH_ASKPASS: ensureSshAskpassScriptPath(),
            SSH_ASKPASS_REQUIRE: 'force',
            DISPLAY: process.env.DISPLAY ?? ':0',
          }
        : undefined;
      const result = runCommandCapture('scp', buildScpArgs({ ssh, knownHostsMode, localPath, remotePath }), env);
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
    if (result.status !== 0) {
      const message = result.stderr.trim() || `SSH failed while detecting remote platform (exit ${result.status}).`;
      throw new Error(message);
    }
    let parsed: { platform?: unknown; arch?: unknown } = {};
    try {
      parsed = JSON.parse(result.stdout || '{}') as { platform?: unknown; arch?: unknown };
    } catch (error) {
      const suffix = result.stderr.trim();
      throw new Error(suffix || `Unable to parse remote platform probe output: ${error instanceof Error ? error.message : String(error ?? '')}`);
    }
    cached = {
      os: normalizeRemoteReleaseOs(parsed.platform),
      arch: normalizeRemoteReleaseArch(parsed.arch),
    };
    return cached;
  };
}

function createLocalRelayHostEngine(params: Readonly<{
  resolveLocalInstallVersion?: (params: Readonly<{
    channel: 'stable' | 'preview' | 'publicdev';
    mode: 'user' | 'system';
    serverBinaryPath: string;
  }>) => Promise<string | null>;
}>) {
  return createRelayHostEngine({
    installRemoteComponent: async () => {
      throw new Error('Remote component installation is not available for local relay host commands.');
    },
    resolveRemoteReleaseTarget: async () => {
      throw new Error('Remote target resolution is not available for local relay host commands.');
    },
    runRemoteText: async () => {
      throw new Error('Remote execution is not available for local relay host commands.');
    },
    copyLocalDirectoryToRemote: async () => {
      throw new Error('Remote copy is not available for local relay host commands.');
    },
    ...(params.resolveLocalInstallVersion ? { resolveLocalInstallVersion: params.resolveLocalInstallVersion } : {}),
  });
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
    throw new Error('Usage: happier relay host <install|status|start|stop|restart|uninstall> [--ssh <user@host>] [--ssh-user <user> --ssh-host <host>] [--ssh-auth agent|keyfile|password] [--identity-file <path>] [--ssh-port <port>] [--mode user|system] [--channel stable|preview|dev] [--env KEY=VALUE]... [--yes] [--json]');
  }

  const interactive = isInteractiveTerminal();

  let rest = args.slice(1);
  const channelFlag = takeFlagValue(rest, '--channel');
  rest = channelFlag.rest;
  const modeFlag = takeFlagValue(rest, '--mode');
  rest = modeFlag.rest;
  const sshFlag = takeFlagValue(rest, '--ssh');
  rest = sshFlag.rest;
  const sshUserFlag = takeFlagValue(rest, '--ssh-user');
  rest = sshUserFlag.rest;
  const sshHostFlag = takeFlagValue(rest, '--ssh-host');
  rest = sshHostFlag.rest;
  const envFlag = takeRepeatedFlagValues(rest, '--env');
  rest = envFlag.rest;
  const serverBinaryFlag = takeFlagValue(rest, '--server-binary');
  rest = serverBinaryFlag.rest;
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
  const sshPort = takeFlagValue(rest, '--ssh-port');
  rest = sshPort.rest;
  const sshAuth = takeFlagValue(rest, '--ssh-auth');
  rest = sshAuth.rest;
  const yesFlag = takeFlag(rest, '--yes');
  rest = yesFlag.rest;
  const jsonFlag = takeFlag(rest, '--json');
  rest = jsonFlag.rest;

  if (rest.length > 0) {
    throw new Error(`Unknown relay host arguments: ${rest.join(' ')}`);
  }

  const channel = normalizeChannel(channelFlag.value);
  const mode = normalizeMode(modeFlag.value);

  if (sshFlag.value && (sshUserFlag.value || sshHostFlag.value)) {
    throw new Error('Do not combine --ssh with --ssh-user/--ssh-host.');
  }

  const sshAuthMode = (() => {
    const raw = String(sshAuth.value ?? '').trim().toLowerCase();
    if (!raw) {
      return identityFile.value?.trim() ? 'keyfile' : 'agent';
    }
    if (raw === 'agent') return 'agent';
    if (raw === 'keyfile') return 'keyfile';
    if (raw === 'password') return 'password';
    throw new Error(`Invalid --ssh-auth value: ${sshAuth.value}`);
  })();

  const parsedLegacyTarget = parseSshTarget(sshFlag.value ?? '');
  const parsedSplitTarget = parseSshTarget(sshHostFlag.value ?? '');
  const sshTargetUsername = sshFlag.value
    ? parsedLegacyTarget.username
    : (sshUserFlag.value?.trim() || parsedSplitTarget.username);
  const sshTargetHost = sshFlag.value
    ? parsedLegacyTarget.host
    : (parsedSplitTarget.host || sshHostFlag.value?.trim() || '');
  const normalizedSshTarget = buildSshTarget({
    username: sshTargetUsername,
    host: sshTargetHost,
  });

  if (sshUserFlag.value && !sshHostFlag.value && !sshFlag.value) {
    throw new Error('Missing required flag: --ssh-host <host>.');
  }
  if (sshHostFlag.value && !normalizedSshTarget) {
    throw new Error('Missing required SSH host.');
  }

  const normalizedPort = (() => {
    const text = String(sshPort.value ?? port.value ?? '').trim();
    if (!text) return null;
    const parsed = Number.parseInt(text, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error('Missing or invalid value for --ssh-port');
    }
    return parsed;
  })();

  const ssh: SystemTaskSshConnectionConfig | null = (sshFlag.value || sshHostFlag.value)
    ? {
        target: normalizedSshTarget,
        auth: sshAuthMode,
        ...(sshAuthMode === 'keyfile'
          ? { identityFile: identityFile.value?.trim() ? identityFile.value.trim() : '' }
          : {}),
        ...(sshConfigFile.value?.trim() ? { sshConfigFile: sshConfigFile.value.trim() } : {}),
        ...(knownHostsPath.value?.trim() ? { knownHostsPath: knownHostsPath.value.trim() } : {}),
        ...(trustedHostKey.value?.trim() ? { trustedHostKey: trustedHostKey.value.trim() } : {}),
        ...(normalizedPort ? { port: normalizedPort } : {}),
      }
    : null;

  if (ssh && !ssh.target) {
    throw new Error('Missing required flag: --ssh <user@host> or --ssh-host <host>.');
  }
  if (ssh && ssh.auth === 'keyfile' && (!ssh.identityFile || !ssh.identityFile.trim())) {
    throw new Error('Missing required flag: --identity-file <path>');
  }

  let sshPassword: string | null = null;
  if (ssh && ssh.auth === 'password') {
    const fromEnv = String(process.env[SSH_PASSWORD_ENV] ?? '').trim();
    if (fromEnv) {
      sshPassword = fromEnv;
    } else if (interactive) {
      sshPassword = (await promptSecret('SSH password: ')).trim();
    }
    if (!sshPassword) {
      throw new Error(`SSH password auth requires ${SSH_PASSWORD_ENV} or an interactive terminal.`);
    }
  }

  const taskParams = resolveRelayRuntimeTaskParams({ channel, mode, ssh });
  const env = envFlag.values.length > 0 ? parseEnvOverrides(envFlag.values) : null;
  const serverBinaryOverride = String(serverBinaryFlag.value ?? '').trim() || null;
  const assumeYes = yesFlag.present;

  if (op === 'status') {
    const engine = ssh
      ? (() => {
          const runner = buildSshRunner(ssh, sshPassword, { assumeYes, interactive, promptInput });
          const resolveRemoteReleaseTarget = createMemoizedResolveRemoteReleaseTarget(runner);
          return createRelayHostEngine({
            resolveRemoteReleaseTarget: async () => await resolveRemoteReleaseTarget(),
            runRemoteText: async ({ remoteCommand }) => await runner.runRemoteText(remoteCommand),
            copyLocalDirectoryToRemote: async ({ localPath, remotePath }) => {
              await runner.copyLocalDirectoryToRemote(localPath, remotePath);
            },
            installRemoteComponent: async () => {
              throw new Error('Remote component installation is not required for status');
            },
          });
        })()
      : createLocalRelayHostEngine({});

    const snapshot = await engine.readStatus(taskParams as RelayRuntimeTaskParams);
    const status: RelayHostStatusJson = {
      installed: snapshot.installed,
      version: snapshot.version,
      service: snapshot.service,
      relayUrl: snapshot.installed ? snapshot.baseUrl : null,
      healthy: typeof snapshot.healthy === 'boolean' ? snapshot.healthy : null,
    };

    if (json) {
      printJsonEnvelope({
        ok: true,
        kind: 'relay_host_status',
        data: status,
      });
      return;
    }

    const out = createOutputBuilder();
    out.section('Relay host status', (section) => {
      section.definitionList([
        { label: 'url', value: status.relayUrl ?? '(not installed)' },
        { label: 'installed', value: status.installed ? 'yes' : 'no' },
        ...(status.version ? [{ label: 'version', value: status.version }] : []),
        { label: 'service', value: status.service.active ? 'running' : 'stopped' },
      ], { indent: '  ' });
    });
    console.log(out.render());
    return;
  }

  if (op === 'install') {
    const localServerPayloadOverride = ssh && serverBinaryOverride
      ? resolveLocalServerPayloadOverrideFromBinaryPath(serverBinaryOverride)
      : null;
    const installParams: RelayRuntimeTaskParams = {
      ...taskParams,
      ...(env ? { env } : {}),
      ...(!ssh && serverBinaryOverride ? { selfHostRelayBinaryOverride: serverBinaryOverride } : {}),
    };
    const result = ssh
      ? (() => {
          const runner = buildSshRunner(ssh, sshPassword, { assumeYes, interactive, promptInput });
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
                  if (payloadParams.componentId === 'happier-server' && localServerPayloadOverride) {
                    return {
                      componentId: payloadParams.componentId,
                      channel: payloadParams.channel,
                      versionId: localServerPayloadOverride.versionId,
                      payloadRoot: localServerPayloadOverride.payloadRoot,
                      source: null,
                      cleanup: async () => undefined,
                    };
                  }
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
          return engine.installOrUpdate(installParams);
        })()
      : (async () => {
          const override = resolveTestFirstPartyPayloadOverride();
          const prepared = override
            ? {
                payloadRoot: override.payloadRoot,
                versionId: override.versionId,
                cleanup: async () => undefined,
              }
            : serverBinaryOverride
                ? null
                : await prepareFirstPartyComponentPayloadFromGitHubRelease({
                    componentId: 'happier-server',
                    channel: channel === 'dev' ? 'publicdev' : channel,
                  });
          try {
            const serverBinaryPath = serverBinaryOverride
              || (prepared ? resolveLocalServerBinaryFromPayloadRoot(prepared.payloadRoot) : null);
            if (!serverBinaryPath) {
              throw new Error('Unable to resolve happier-server binary from prepared payload.');
            }

            const engine = createLocalRelayHostEngine({
              resolveLocalInstallVersion: async ({ serverBinaryPath: candidate }) => {
                if (prepared && candidate === serverBinaryPath) return prepared.versionId || null;
                return null;
              },
            });

            return await engine.installOrUpdate({
              ...installParams,
              selfHostRelayBinaryOverride: serverBinaryPath,
            });
          } finally {
            await prepared?.cleanup?.();
          }
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

    const out = createOutputBuilder();
    out.line(ok('Relay host installed'));
    out.line(`  ${payload.relayUrl}`);
    console.log(out.render());
    return;
  }

  if (op === 'start' || op === 'stop' || op === 'restart' || op === 'uninstall') {
    const engine = ssh
      ? (() => {
          const runner = buildSshRunner(ssh, sshPassword, { assumeYes, interactive, promptInput });
          const resolveRemoteReleaseTarget = createMemoizedResolveRemoteReleaseTarget(runner);
          return createRelayHostEngine({
            resolveRemoteReleaseTarget: async () => await resolveRemoteReleaseTarget(),
            runRemoteText: async ({ remoteCommand }) => await runner.runRemoteText(remoteCommand),
            copyLocalDirectoryToRemote: async ({ localPath, remotePath }) => {
              await runner.copyLocalDirectoryToRemote(localPath, remotePath);
            },
            installRemoteComponent: async () => {
              throw new Error('Remote component installation is not required for control');
            },
          });
        })()
      : createLocalRelayHostEngine({});

    await engine.control({ ...taskParams, action: op });

    if (json) {
      printJsonEnvelope({
        ok: true,
        kind: `relay_host_${op}`,
        data: { ok: true },
      });
      return;
    }

    const out = createOutputBuilder();
    out.line(ok(`Relay host ${op} requested`));
    console.log(out.render());
    return;
  }

  throw new Error(`Unknown relay host subcommand: ${op}`);
}
