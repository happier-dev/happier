import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import chalk from 'chalk';

import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { configuration, reloadConfiguration } from '@/configuration';
import { isInteractiveTerminal, promptInput } from '@/terminal/prompts/promptInput';
import { listCurrentMachineNetworkAddressCandidates } from '@/server/reachability/currentMachineReachableServerUrlCandidates';
import { buildServerUrlReachabilityHintLines } from '@/server/reachability/serverUrlReachabilityHint';
import { getActiveServerProfile, upsertServerProfileByUrl, type ServerProfile } from '@/server/serverProfiles';
import { runServerSelectionBackgroundServiceFollowUp } from '../backgroundServiceFollowUp';

import {
  prepareFirstPartyComponentPayloadFromGitHubRelease,
  resolveManagedCliReleaseChannelSync,
  resolveRelayRuntimeDefaults,
} from '@happier-dev/cli-common/firstPartyRuntime';
import { createRelayHostEngine } from '@happier-dev/cli-common/relayHost';
import {
  installRemoteFirstPartyComponent,
  normalizeRemoteReleaseArch,
  normalizeRemoteReleaseOs,
  type RelayRuntimeStatusSnapshot,
  type RelayRuntimeTaskParams,
  type SystemTaskSshConnectionConfig,
} from '@happier-dev/cli-common/systemTasks';
import { getReleaseRingPublicLabel, normalizePublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import {
  classifyTailscaleServeRootSlot,
  runTailscaleServeEnable,
  runTailscaleServeStatus,
} from '@happier-dev/cli-common/tailscale';
import { readTailscaleStatusSnapshot } from '@/integrations/tailscale/tailscaleStatus';
import { promptConfirmYesNo } from '@/terminal/prompts/promptConfirmYesNo';
import { defaultNameFromUrl, defaultWebappUrlFromServerUrl } from '../server/commandUtilities';
import { describeRelayBindSignupExposure } from './hostBindSignupNotice';
import { resolveRelayHostReachableServerUrl } from './hostReachability';
import {
  decideTailscaleServeOffer,
  offerAndPublishRelayOnTailnet,
  shouldProbeTailscaleForServeOffer,
} from './hostTailscaleServe';

type RelayHostStatusJson = Readonly<{
  installed: boolean;
  version: string | null;
  service: RelayRuntimeStatusSnapshot['service'];
  relayUrl: string | null;
  healthy: boolean | null;
  warnings?: readonly string[];
}>;

type RelayHostInstallJson = Readonly<{
  relayUrl: string;
  mode: 'user' | 'system';
}>;

function normalizeRelayUrlForComparison(raw: string): string {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  try {
    return new URL(value).toString().replace(/\/+$/, '');
  } catch {
    return value.replace(/\/+$/, '');
  }
}

function relayUrlsMatch(left: string, right: string): boolean {
  const normalizedLeft = normalizeRelayUrlForComparison(left);
  const normalizedRight = normalizeRelayUrlForComparison(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function resolveInstalledRelayProfileTarget(params: Readonly<{
  relayUrl: string;
  activeProfileBeforeInstall: Awaited<ReturnType<typeof getActiveServerProfile>> | null;
  /**
   * The address other devices should use, when it differs from the bind URL.
   * Only consulted once the existing configuration has failed to supply a
   * canonical URL of its own, so an already-configured relay keeps its answer.
   */
  reachableServerUrl?: string | null;
}>): Readonly<{
  name: string;
  serverUrl: string;
  localServerUrl?: string;
  webappUrl: string;
}> {
  const relayUrl = params.relayUrl;
  const configuredServerUrl = configuration.serverUrl;
  const configuredApiServerUrl = configuration.apiServerUrl;
  const configuredWebappUrl = configuration.webappUrl;
  const active = params.activeProfileBeforeInstall;
  const activeMatchesInstalledRelay =
    active && active.id !== 'cloud' && (
      relayUrlsMatch(active.serverUrl, relayUrl) ||
      (active.localServerUrl ? relayUrlsMatch(active.localServerUrl, relayUrl) : false)
    );

  if (
    relayUrlsMatch(configuredApiServerUrl, relayUrl) &&
    configuredServerUrl &&
    !relayUrlsMatch(configuredServerUrl, relayUrl)
  ) {
    return {
      name: active && active.id !== 'cloud' ? active.name : defaultNameFromUrl(configuredServerUrl),
      serverUrl: configuredServerUrl,
      localServerUrl: relayUrl,
      webappUrl: configuredWebappUrl || defaultWebappUrlFromServerUrl(configuredServerUrl),
    };
  }

  if (activeMatchesInstalledRelay && active && !relayUrlsMatch(active.serverUrl, relayUrl)) {
    return {
      name: active.name,
      serverUrl: active.serverUrl,
      localServerUrl: relayUrl,
      webappUrl: active.webappUrl,
    };
  }

  const reachableServerUrl = String(params.reachableServerUrl ?? '').trim();
  if (reachableServerUrl && !relayUrlsMatch(reachableServerUrl, relayUrl)) {
    return {
      name: active && active.id !== 'cloud' ? active.name : defaultNameFromUrl(reachableServerUrl),
      serverUrl: reachableServerUrl,
      localServerUrl: relayUrl,
      webappUrl: defaultWebappUrlFromServerUrl(reachableServerUrl),
    };
  }

  return {
    name: active && active.id !== 'cloud' ? active.name : defaultNameFromUrl(relayUrl),
    serverUrl: relayUrl,
    webappUrl: defaultWebappUrlFromServerUrl(relayUrl),
  };
}

/**
 * What a running daemon would actually connect to for a profile. Re-installing
 * the same relay must not ask to restart a background service that is already
 * following it.
 */
function relayProfileConnectionIdentity(profile: ServerProfile | null): string {
  if (!profile) return '';
  return [
    profile.id,
    normalizeRelayUrlForComparison(profile.serverUrl),
    normalizeRelayUrlForComparison(profile.localServerUrl ?? ''),
  ].join('|');
}

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
    const eq = entry.indexOf('=');
    if (eq < 0) {
      throw new Error(`Invalid --env value (expected KEY=VALUE): ${entry}`);
    }
    const key = entry.slice(0, eq).trim();
    const value = entry.slice(eq + 1);
    if (!key) {
      throw new Error(`Invalid --env value (expected KEY=VALUE): ${entry}`);
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
    const normalized = normalizePublicReleaseRingId(explicit);
    if (!normalized) return 'stable';
    return getReleaseRingPublicLabel(normalized);
  }
  const inferred = resolveManagedCliReleaseChannelSync({
    processEnv: process.env,
    argv: process.argv,
    argv0: process.argv0,
    execPath: process.execPath,
  }).ringId;
  return getReleaseRingPublicLabel(inferred);
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
    throw new Error(`relay binary not found: ${binaryPath || '(empty)'}`);
  }
  const binaryDir = dirname(binaryPath);
  const payloadRoot = basename(binaryDir) === 'bin'
    ? dirname(binaryDir)
    : binaryDir;
  if (!existsSync(payloadRoot) || !lstatSync(payloadRoot).isDirectory()) {
    throw new Error(`relay payload root not found: ${payloadRoot}`);
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

function createInvalidArgumentsError(message: string): Error & { code: 'invalid_arguments' } {
  const error = new Error(message) as Error & { code: 'invalid_arguments' };
  error.code = 'invalid_arguments';
  return error;
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
    throw new Error('Usage: happier relay host <install|status|start|stop|restart|uninstall> [--ssh <user@host>] [--mode user|system] [--channel stable|preview|dev] [--env KEY=VALUE]... [--server-binary <path>] [--lan | --expose | --host <ip>] [--preserve-active-server] [--yes] [--json]');
  }

  let rest = args.slice(1);
  const channelFlag = takeFlagValue(rest, '--channel');
  rest = channelFlag.rest;
  const modeFlag = takeFlagValue(rest, '--mode');
  rest = modeFlag.rest;
  const sshFlag = takeFlagValue(rest, '--ssh');
  rest = sshFlag.rest;
  const envFlag = takeRepeatedFlagValues(rest, '--env');
  rest = envFlag.rest;
  const serverBinaryFlag = takeFlagValue(rest, '--server-binary');
  rest = serverBinaryFlag.rest;
  const selfHostServerBinaryFlag = takeFlagValue(rest, '--self-host-server-binary');
  rest = selfHostServerBinaryFlag.rest;
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
  const preserveActiveServerFlag = takeFlag(rest, '--preserve-active-server');
  rest = preserveActiveServerFlag.rest;
  const lanFlag = takeFlag(rest, '--lan');
  rest = lanFlag.rest;
  const exposeFlag = takeFlag(rest, '--expose');
  rest = exposeFlag.rest;
  const hostFlag = takeFlagValue(rest, '--host');
  rest = hostFlag.rest;
  const yesFlag = takeFlag(rest, '--yes');
  rest = yesFlag.rest;
  const jsonFlag = takeFlag(rest, '--json');
  rest = jsonFlag.rest;

  if (rest.length > 0) {
    throw createInvalidArgumentsError(`Unknown relay host arguments: ${rest.join(' ')}`);
  }

  const bindFlagCount = [lanFlag.present, exposeFlag.present, hostFlag.value !== null].filter(Boolean).length;
  if (bindFlagCount > 1) {
    throw createInvalidArgumentsError('--lan, --expose, and --host are mutually exclusive.');
  }
  if (bindFlagCount > 0 && sshFlag.value) {
    throw createInvalidArgumentsError('--lan, --expose, and --host cannot be used with --ssh (applies to local installs only).');
  }
  if (bindFlagCount > 0 && op !== 'install') {
    throw createInvalidArgumentsError('--lan, --expose, and --host can only be used with the install subcommand.');
  }

  const channel = normalizeChannel(channelFlag.value);
  const mode = normalizeMode(modeFlag.value);
  const preserveActiveServer = preserveActiveServerFlag.present;

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
    throw createInvalidArgumentsError('Missing required flag: --ssh <user@host>');
  }
  if (serverBinaryFlag.value && selfHostServerBinaryFlag.value) {
    throw createInvalidArgumentsError('Do not combine --server-binary with --self-host-server-binary.');
  }
  if (ssh && selfHostServerBinaryFlag.value) {
    throw createInvalidArgumentsError('Use --server-binary instead of --self-host-server-binary for relay host install over SSH.');
  }

  const taskParams = resolveRelayRuntimeTaskParams({ channel, mode, ssh });
  const env = envFlag.values.length > 0 ? parseEnvOverrides(envFlag.values) : null;
  const selfHostRelayBinaryOverride = String(serverBinaryFlag.value ?? selfHostServerBinaryFlag.value ?? '').trim() || null;
  const localEngine = createLocalRelayHostEngine({});

  if (op === 'status') {
    const engine = ssh
      ? (() => {
          const runner = buildSshRunner(ssh);
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
      : localEngine;

    const payload = engine.readStatus(taskParams as RelayRuntimeTaskParams).then((status) => ({
      installed: status.installed,
      version: status.version,
      service: status.service,
      relayUrl: status.installed ? status.baseUrl : null,
      healthy: status.healthy,
      ...(status.warnings && status.warnings.length > 0 ? { warnings: status.warnings } : {}),
    }));

    const status = await payload;

    if (json) {
      await printJsonEnvelope({
        ok: true,
        kind: 'relay_host_status',
        data: status,
      });
      return;
    }

    console.log(chalk.bold('Relay host status'));
    console.log(chalk.gray(`  url: ${status.relayUrl ?? '(not installed)'}`));
    console.log(chalk.gray(`  installed: ${status.installed ? 'yes' : 'no'}`));
    if (status.version) console.log(chalk.gray(`  version: ${status.version}`));
    console.log(chalk.gray(`  service: ${status.service.active ? 'running' : 'stopped'}`));
    for (const warning of status.warnings ?? []) {
      console.log(chalk.yellow(`  warning: ${warning}`));
    }
    return;
  }

  if (op === 'install') {
    // Captured before the install runs. The relay generates its own master
    // secret the first time it starts and never mentions it again; a data
    // directory that does not exist yet is what tells us this install is that
    // first time. A remote install creates it on the other machine, where this
    // path would be a lie, so it is left out of that case entirely.
    const localRelayDataDir = ssh
      ? null
      : resolveRelayRuntimeDefaults({
        platform: process.platform,
        mode,
        // `channel` here is the public label ('dev'); the engine resolves its own
        // defaults through the same normalizer, so both land on the same paths.
        channel: normalizePublicReleaseRingId(channel) || 'stable',
        homeDir: homedir(),
      }).dataDir;
    const relayDataDirExistedBeforeInstall = localRelayDataDir ? existsSync(localRelayDataDir) : true;

    let bindHost: string | null = null;
    if (exposeFlag.present || hostFlag.value?.trim() === '0.0.0.0') {
      bindHost = '0.0.0.0';
    } else if (lanFlag.present) {
      const entries = listCurrentMachineNetworkAddressCandidates().filter((entry) => entry.family === 4);
      if (entries.length === 0) {
        throw new Error('No LAN/Tailscale network interfaces detected. Use --host <ip> to specify a bind address explicitly.');
      }
      if (entries.length === 1) {
        bindHost = entries[0].address;
        console.log(chalk.gray(`→ Binding to ${entries[0].label} ${entries[0].address}`));
      } else if (isInteractiveTerminal()) {
        console.log('Multiple network interfaces found. Which one should the relay listen on?\n');
        for (let i = 0; i < entries.length; i++) {
          console.log(`  ${i + 1}) ${entries[i].label}   ${entries[i].address}`);
        }
        console.log('');
        const answer = await promptInput(`Enter a number (1–${entries.length}): `);
        const index = Number(answer.trim()) - 1;
        if (!Number.isInteger(index) || index < 0 || index >= entries.length) {
          throw new Error(`Invalid selection. Expected a number between 1 and ${entries.length}.`);
        }
        bindHost = entries[index].address;
        console.log(chalk.gray(`→ Binding to ${entries[index].label} ${bindHost}`));
      } else {
        const list = entries.map((e, i) => `  ${i + 1}) ${e.label}   ${e.address}`).join('\n');
        throw new Error(`Multiple LAN/Tailscale interfaces detected:\n${list}\nUse --host <ip> to specify one explicitly.`);
      }
    } else if (hostFlag.value) {
      bindHost = hostFlag.value.trim();
    }

    const bindEnv: Record<string, string> = bindHost ? { HAPPIER_SERVER_HOST: bindHost } : {};
    const mergedEnv = (env !== null || Object.keys(bindEnv).length > 0) ? { ...(env ?? {}), ...bindEnv } : null;

    const localServerPayloadOverride = selfHostRelayBinaryOverride
      ? resolveLocalServerPayloadOverrideFromBinaryPath(selfHostRelayBinaryOverride)
      : null;
    const installParams: RelayRuntimeTaskParams = {
      ...taskParams,
      ...(mergedEnv ? { env: mergedEnv } : {}),
      ...(selfHostRelayBinaryOverride ? { selfHostRelayBinaryOverride } : {}),
    };
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
            installRemoteComponent: async ({ componentId, channel, ssh, knownHostsMode, installerBinaryPath, localBinaryPath, remoteHomeDir }) => {
              const out = await installRemoteFirstPartyComponent({
                componentId,
                channel,
                ssh,
                knownHostsMode,
                installerBinaryPath,
                localBinaryPath,
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
          const prepared = await (async () => {
            if (localServerPayloadOverride) {
              return {
                payloadRoot: localServerPayloadOverride.payloadRoot,
                versionId: localServerPayloadOverride.versionId,
                cleanup: async () => undefined,
              };
            }
            if (override) {
              return {
                payloadRoot: override.payloadRoot,
                versionId: override.versionId,
                cleanup: async () => undefined,
              };
            }
            return await prepareFirstPartyComponentPayloadFromGitHubRelease({
              componentId: 'happier-server',
              channel: channel === 'dev' ? 'publicdev' : channel,
            });
          })();
          try {
            const serverBinaryPath = selfHostRelayBinaryOverride || resolveLocalServerBinaryFromPayloadRoot(prepared.payloadRoot);
            if (!serverBinaryPath) {
              throw new Error('Unable to resolve relay binary (happier-server) from prepared payload.');
            }

            const engine = createLocalRelayHostEngine({
              resolveLocalInstallVersion: async ({ serverBinaryPath: candidate }) => {
                if (candidate === serverBinaryPath) {
                  return localServerPayloadOverride?.versionId || prepared.versionId || null;
                }
                return null;
              },
            });

            return await engine.installOrUpdate({
              ...installParams,
              selfHostRelayBinaryOverride: serverBinaryPath,
            });
          } finally {
            await prepared.cleanup();
          }
        })();

    const activeProfileBeforeInstall = await getActiveServerProfile().catch(() => null);
    const payload: RelayHostInstallJson = await result;

    if (!json) {
      console.log(chalk.green('✓ Relay host installed'));
      console.log(chalk.gray(`  ${payload.relayUrl}`));
      if (localRelayDataDir && !relayDataDirExistedBeforeInstall) {
        console.log('');
        console.log(chalk.yellow('  This relay generated a master secret in'));
        console.log(chalk.gray(`    ${localRelayDataDir}`));
        console.log(chalk.gray('  It encrypts what the relay stores, is saved nowhere else, and cannot be'));
        console.log(chalk.gray("  regenerated. Keep it with your backup of the relay's database."));
        console.log('');
      }

      // A relay bound past loopback is reachable by whoever shares that network,
      // and anonymous signup is on by default. Say so once, here, where the bind
      // was just chosen. Information only: no prompt, no policy, no changed env.
      // Read from the emitted env rather than `bindHost` so `--env
      // HAPPIER_SERVER_HOST=...` — the other way to move this bind — is not a
      // silent gap. Skipped for `--ssh`, which cannot carry a bind flag and
      // whose relay is not on "this computer" anyway.
      const signupExposure = ssh ? null : describeRelayBindSignupExposure(mergedEnv?.HAPPIER_SERVER_HOST ?? null);
      if (signupExposure) {
        console.log('');
        console.log(chalk.yellow(`  ${signupExposure.headline}`));
        for (const line of signupExposure.details) {
          console.log(chalk.gray(`  ${line}`));
        }
        console.log('');
      }
    }

    // The bind URL is what the relay listens on, not what a phone can reach.
    // Settle that here, before the profile is written, so `happier auth login`
    // binds the account to an address the user's other devices can actually
    // use. `--json` callers (including the SSH installer, which drives a remote
    // `relay host install --json`) are left exactly as they were: probing this
    // machine's interfaces would be answering the wrong question for them.
    const configuredProfile = resolveInstalledRelayProfileTarget({
      relayUrl: payload.relayUrl,
      activeProfileBeforeInstall,
    });
    const shouldResolveReachableUrl =
      !json && !ssh && relayUrlsMatch(configuredProfile.serverUrl, payload.relayUrl);

    // Publishing on the tailnet has to happen before candidates are collected:
    // the Serve URL is what makes a loopback relay reachable, and the collector
    // below is what discovers and ranks it.
    const interactiveInstall = isInteractiveTerminal() && !yesFlag.present;
    if (
      shouldResolveReachableUrl
      // Checked before anything is asked of Tailscale, so an install that could
      // never offer does not pay for a `tailscale` subprocess to find that out.
      && shouldProbeTailscaleForServeOffer({
        interactive: interactiveInstall,
        relayUrl: payload.relayUrl,
      })
    ) {
      const serveStatus = await runTailscaleServeStatus().catch(() => null);
      const publish = await offerAndPublishRelayOnTailnet({
        decision: decideTailscaleServeOffer({
          interactive: interactiveInstall,
          tailscale: await readTailscaleStatusSnapshot(),
          relayUrl: payload.relayUrl,
          serveSlot: serveStatus === null
            ? null
            : classifyTailscaleServeRootSlot(serveStatus, payload.relayUrl),
        }),
        confirm: async (question) => await promptConfirmYesNo(question, { default: 'yes' }),
        enableServe: async (upstreamUrl) => await runTailscaleServeEnable({ upstreamUrl }),
      });

      if (publish.kind === 'conflict') {
        console.log(chalk.yellow(`  Tailscale ${publish.exposure === 'funnel' ? 'Funnel' : 'Serve'} already uses this HTTPS address.`));
        if (publish.httpsUrl) console.log(chalk.gray(`    ${publish.httpsUrl}`));
        console.log(chalk.gray('  Existing Tailscale routing was left unchanged.'));
      } else if (publish.kind === 'approvalNeeded') {
        console.log(chalk.yellow('  Your tailnet needs an admin to approve this before the address works:'));
        console.log(chalk.yellow(`    ${publish.approvalUrl}`));
        console.log(chalk.gray('  Re-run `happier relay host install` once it is approved.'));
      } else if (publish.kind === 'failed') {
        // The relay is installed by now; a Serve failure must not unwind it.
        console.log(chalk.yellow(`  Could not publish on your tailnet: ${publish.message}`));
        console.log(chalk.gray('  The relay is installed. You can publish it later with `tailscale serve`.'));
      }
    }

    const reachable = shouldResolveReachableUrl
      ? await resolveRelayHostReachableServerUrl({
          relayUrl: payload.relayUrl,
          interactive: isInteractiveTerminal() && !yesFlag.present,
        })
      : null;

    if (reachable?.kind === 'localOnly') {
      for (const line of buildServerUrlReachabilityHintLines(payload.relayUrl)) {
        console.log(chalk.gray(`  ${line}`));
      }
    } else if (reachable?.kind === 'selected') {
      if (reachable.chosenBy === 'default') {
        console.log(chalk.gray('  Reachable from other devices at:'));
        for (const candidate of reachable.candidates) {
          console.log(chalk.gray(`    ${candidate.url} (${candidate.label})`));
        }
        if (reachable.rejectedAnswer) {
          console.log(chalk.yellow(`  Not a usable relay URL: ${reachable.rejectedAnswer}`));
        }
      }
      console.log(chalk.gray(`  Using ${reachable.url} as this relay's address.`));
      if (reachable.chosenBy === 'default') {
        console.log(chalk.gray('  Run `happier server add` to use a different address.'));
      }
    }

    const installedProfile = resolveInstalledRelayProfileTarget({
      relayUrl: payload.relayUrl,
      activeProfileBeforeInstall,
      reachableServerUrl: reachable?.kind === 'selected' ? reachable.url : null,
    });
    const activeProfileAfterInstall = await upsertServerProfileByUrl({
      ...installedProfile,
      use: !preserveActiveServer,
    });
    reloadConfiguration();

    if (json) {
      await printJsonEnvelope({
        ok: true,
        kind: 'relay_host_install',
        data: payload,
      });
      return;
    }

    // The background service resolved its relay when it started, which was
    // before this install pointed the machine somewhere else. Without this it
    // keeps talking to the previous relay while the install reports success.
    if (
      !preserveActiveServer
      && relayProfileConnectionIdentity(activeProfileBeforeInstall)
        !== relayProfileConnectionIdentity(activeProfileAfterInstall)
    ) {
      await runServerSelectionBackgroundServiceFollowUp({
        interactive: isInteractiveTerminal(),
        targetServerUrl: activeProfileAfterInstall.serverUrl,
      });
    }

    return;
  }

  if (op === 'start' || op === 'stop' || op === 'restart' || op === 'uninstall') {
    const engine = ssh
      ? (() => {
          const runner = buildSshRunner(ssh);
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
      : localEngine;
    await engine.control({ ...taskParams, action: op });

    if (json) {
      await printJsonEnvelope({
        ok: true,
        kind: `relay_host_${op}`,
        data: { ok: true },
      });
      return;
    }

    // All ops finished synchronously at the service-manager level:
    //  - uninstall: service deregistered + files removed before control() returns.
    //  - start/stop/restart: launchctl/systemctl has accepted the request; the
    //    bootstrap retry + kickstart path (in apply.ts) ensures the service
    //    is in the domain and the program started before this line is reached.
    // Past tense reflects what `launchctl list` / `systemctl status` will
    // report immediately after.
    const verbPastTense: Record<string, string> = {
      uninstall: 'uninstalled',
      start: 'started',
      stop: 'stopped',
      restart: 'restarted',
    };
    console.log(chalk.green(`✓ Relay host ${verbPastTense[op] ?? `${op}ed`}`));
    return;
  }

  throw new Error(`Unknown relay host subcommand: ${op}`);
}
