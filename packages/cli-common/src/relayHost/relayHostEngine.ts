import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { spawnBackgroundSync } from '../process/spawnBackgroundSync.js';
import { rm, readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, posix as posixPath } from 'node:path';

import { normalizePublicReleaseRingId, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import { DEFAULT_HAPPIER_CLOUD_SERVER_URL } from '../happierCloud.js';
import { parsePowerShellQuotedText } from '../service/discovery/_shared.js';

import {
  applyServicePlan,
  buildServiceCommandEnv,
  buildReadWindowsScheduledTaskStatusPowerShellCommand,
  buildServiceDefinition,
  parseWindowsScheduledTaskStatusPowerShellJson,
  resolveServiceBackend,
  planServiceAction,
  type ServiceBackend,
  type ServiceSpec,
} from '../service/index.js';
import {
  checkRelayRuntimeHealth,
  resolveRelayRuntimeDefaults,
  type RelayRuntimeDefaults,
} from '../firstPartyRuntime/relayRuntime.js';
import {
  installOrUpdateRelayRuntimeLocal,
  shouldMigrateLegacyUnsuffixedRelayRuntimeInstallRoot,
  uninstallRelayRuntimePayloadLocal,
  waitForRelayRuntimeStartupReceipt,
} from '../firstPartyRuntime/relayRuntimeInstall.js';
import {
  isLocalRelayPortBindable,
  resolveNonCollidingRelayPort,
} from '../firstPartyRuntime/resolveNonCollidingRelayPort.js';
import {
  mergeSelfHostServerEnvText,
  parseEnvText,
  renderPrismaCompatibleSqliteDatabaseUrl,
  resolveServerLightSqliteDatabaseUrlOptionsFromEnv,
  resolveSelfHostSqliteAutoMigrateValue,
  renderSelfHostServerEnvTextFromResolvedValues,
  resolveConfiguredSelfHostBaseUrl,
} from '../firstPartyRuntime/selfHostServerEnv.js';
import {
  createPersonalHomeRuntimeSpec,
  parsePersonalHomeRuntimePurpose,
  type ManagedRelayPurpose,
} from '../firstPartyRuntime/personalHome/personalHomeRuntimeSpec.js';
import { resolvePersonalHomeRuntimeLayout } from '../firstPartyRuntime/personalHome/layout.js';
import type { PersonalHomeRuntimeLayout } from '../firstPartyRuntime/personalHome/layout.js';
import { withPersonalHomeOperationLock } from '../firstPartyRuntime/personalHome/lock.js';
import { withPersonalHomeOperationAdmission } from '../firstPartyRuntime/personalHome/operationAdmission.js';
import { hasMeaningfulPersonalHomeData } from '../firstPartyRuntime/personalHome/restore.js';
import { assertPersonalHomeRelocationSourceAllowsActivation } from '../firstPartyRuntime/personalHome/relocationCoordinator.js';
import { assertPersonalHomeRelocationDestinationAllowsActivation } from '../firstPartyRuntime/personalHome/relocationDestination.js';
import { readEffectivePersonalHomeSignupPolicy } from '../firstPartyRuntime/personalHomeSignupPolicy.js';
import { withFirstPartyPayloadMutationLock } from '../firstPartyRuntime/withFirstPartyPayloadMutationLock.js';
import { createPersonalHomeRestorePointWithLease, openPersonalHomeRestorePointWithLease } from '../firstPartyRuntime/personalHome/restorePoint.js';
import {
  createPersonalHomeSqliteMaintenance,
  finalizePersonalHomeSanitizedConfiguration,
  inspectPersonalHomeSanitizedConfigurationStorage,
  preparePersonalHomeSanitizedConfiguration,
  recoverPersonalHomeSanitizedConfiguration,
  readCanonicalPersonalHomeIdentity,
  readPersonalHomeIdentityValueFromSqlite,
  readPersonalHomeDataCountsFromSqlite,
  readPersonalHomeSanitizedConfiguration,
  validateCanonicalPersonalHomeLayout,
} from '../firstPartyRuntime/personalHome/productionAdapters.js';

import { buildRelayRuntimeHealthProbeCommand, RELAY_RUNTIME_HEALTH_OK_TOKEN } from './buildRelayRuntimeHealthProbeCommand.js';

import type {
  RelayRuntimeStatusSnapshot,
  RelayRuntimeTaskParams,
  SystemTaskSshConnectionConfig,
} from '../systemTasks/kinds/relayRuntimeKinds.js';
import { buildRemoteBootstrapCommand } from '../systemTasks/ssh/remoteBootstrapCommandBuilder.js';
import { parseJsonLinesBestEffort } from '../ssh/index.js';

export type RelayHostRemoteCommandResult = Readonly<{ status: number; stdout: string; stderr: string }>;

type RemoteReleaseTarget = Readonly<{ os: 'linux' | 'darwin'; arch: 'x64' | 'arm64' }>;

function renderRelaySqliteDatabaseUrl(params: Readonly<{
  dbPath: string;
  platform: string;
  env?: Readonly<Record<string, unknown>>;
}>): string {
  return renderPrismaCompatibleSqliteDatabaseUrl({
    dbPath: params.dbPath,
    platform: params.platform,
    sqlite: resolveServerLightSqliteDatabaseUrlOptionsFromEnv(params.env ?? process.env),
  });
}

type RemoteDeps = Readonly<{
  resolveRemoteReleaseTarget: (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    knownHostsMode?: 'app' | 'system';
    signal?: AbortSignal;
  }>) => Promise<RemoteReleaseTarget>;
  runRemoteText: (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    remoteCommand: string;
    knownHostsMode?: 'app' | 'system';
    signal?: AbortSignal;
  }>) => Promise<RelayHostRemoteCommandResult>;
  copyLocalDirectoryToRemote: (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    localPath: string;
    remotePath: string;
    knownHostsMode?: 'app' | 'system';
    signal?: AbortSignal;
  }>) => Promise<void>;
}>;

type RemoteInstaller = (params: Readonly<{
  componentId: 'happier-cli' | 'happier-server';
  channel?: string;
  ssh: SystemTaskSshConnectionConfig;
  knownHostsMode?: 'app' | 'system';
  installerBinaryPath?: string;
  localBinaryPath?: string;
  remoteHomeDir?: string;
  signal?: AbortSignal;
}>) => Promise<Readonly<{ binaryPath: string; versionId: string }>>;

function parsePersistedManagedRelayPurpose(value: unknown): ManagedRelayPurpose | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind === 'generic') return { kind: 'generic' };
  if (record.kind !== 'personal-home') return undefined;
  try {
    const spec = parsePersonalHomeRuntimePurpose(record);
    return { kind: 'personal-home', canonicalServerUrl: spec.canonicalServerUrl };
  } catch {
    return undefined;
  }
}

async function readOptionalMutationAuthorityText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

async function readPersistedManagedRelayPurpose(defaults: RelayRuntimeDefaults): Promise<ManagedRelayPurpose | undefined> {
  const statePath = join(defaults.installRoot, 'self-host-state.json');
  const stateText = await readOptionalMutationAuthorityText(statePath);
  if (!stateText.trim()) return undefined;
  return parsePersistedManagedRelayPurpose(tryParseJsonObject(stateText)?.purpose);
}

async function resolvePersistedLocalPersonalHomeLayout(params: Readonly<{
  defaults: RelayRuntimeDefaults;
  homeDir: string;
  platform: NodeJS.Platform;
}>): Promise<PersonalHomeRuntimeLayout> {
  const envPath = join(params.defaults.configDir, 'server.env');
  const envText = await readOptionalMutationAuthorityText(envPath);
  return resolvePersonalHomeRuntimeLayout({
    env: {
      ...parseEnvText(envText),
      HAPPIER_SELF_HOST_INSTALL_ROOT: params.defaults.installRoot,
      HAPPIER_SELF_HOST_CONFIG_DIR: params.defaults.configDir,
      HAPPIER_SELF_HOST_LOG_DIR: params.defaults.logDir,
    },
    homeDir: params.homeDir,
    mode: params.defaults.mode,
    platform: params.platform,
    channel: params.defaults.channel,
  });
}

export class PersonalHomeRuntimeClassificationRequiredError extends Error {
  readonly code = 'PERSONAL_HOME_CLASSIFICATION_REQUIRED' as const;

  constructor() {
    super('Preserved Home data exists but the managed runtime purpose is missing or invalid. Retry through an explicit matching Personal Home install or recover the runtime state.');
    this.name = 'PersonalHomeRuntimeClassificationRequiredError';
  }
}

export class PersonalHomeBootstrapInterruptedError extends Error {
  readonly code = 'personal_home_bootstrap_interrupted' as const;

  constructor() {
    super('Personal Home changed during setup. Review the current state and retry deliberately.');
    this.name = 'PersonalHomeBootstrapInterruptedError';
  }
}

export class RelayHostLifecyclePostconditionError extends Error {
  readonly code = 'relay_host_lifecycle_postcondition_failed' as const;
  readonly action: 'stop' | 'uninstall';
  readonly service: RelayRuntimeStatusSnapshot['service'];
  readonly terminalState: 'active' | 'registered-inactive' | 'deregistered' | 'indeterminate';

  constructor(params: Readonly<{
    action: 'stop' | 'uninstall';
    service: RelayRuntimeStatusSnapshot['service'];
    terminalState: RelayHostLifecyclePostconditionError['terminalState'];
  }>) {
    super(
      `Relay runtime ${params.action} command completed without proving its terminal service state: `
      + `state=${params.terminalState}, enabled=${String(params.service.enabled)}, active=${String(params.service.active)}.`,
    );
    this.name = 'RelayHostLifecyclePostconditionError';
    this.action = params.action;
    this.service = params.service;
    this.terminalState = params.terminalState;
  }
}

async function assertExplicitPersonalHomeMatchesPreservedConfiguration(params: Readonly<{
  defaults: RelayRuntimeDefaults;
  requested: ManagedRelayPurpose | undefined;
}>): Promise<void> {
  if (params.requested?.kind !== 'personal-home') {
    throw new PersonalHomeRuntimeClassificationRequiredError();
  }
  const envPath = join(params.defaults.configDir, 'server.env');
  const envText = existsSync(envPath) ? await readFile(envPath, 'utf8').catch(() => '') : '';
  const env = parseEnvText(envText);
  const configuredCanonicalServerUrl = String(env.HAPPIER_CANONICAL_SERVER_URL ?? '').trim()
    || (String(env.HAPPIER_PUBLIC_SERVER_URL_INFERRED ?? '').trim() === '1'
      ? ''
      : String(env.HAPPIER_PUBLIC_SERVER_URL ?? '').trim());
  if (!configuredCanonicalServerUrl || configuredCanonicalServerUrl !== params.requested.canonicalServerUrl) {
    throw new PersonalHomeRuntimeClassificationRequiredError();
  }
}

/**
 * The persisted Personal Home purpose is authoritative at the local mutation seam: an omitted
 * purpose inherits it, a compatible explicit purpose cannot override the persisted canonical
 * origin, and an incompatible explicit purpose is rejected before any lock is taken or any
 * runtime byte is written. A runtime without a persisted Personal Home purpose keeps the
 * caller's requested purpose (fresh installs and generic relays are unaffected).
 */
function resolveEffectiveLocalMutationPurpose(params: Readonly<{
  persisted: ManagedRelayPurpose | undefined;
  requested: ManagedRelayPurpose | undefined;
}>): ManagedRelayPurpose | undefined {
  if (params.persisted?.kind !== 'personal-home') return params.requested;
  if (!params.requested) return params.persisted;
  if (params.requested.kind === 'generic') {
    throw new Error(
      'This managed relay runtime is an installed Personal Home; a generic purpose cannot declassify it. '
      + 'Use the Personal Home operations (backup/restore/erase) instead.',
    );
  }
  if (params.requested.canonicalServerUrl !== params.persisted.canonicalServerUrl) {
    throw new Error(
      `Personal Home canonicalServerUrl is immutable: the runtime persists ${params.persisted.canonicalServerUrl}, not ${params.requested.canonicalServerUrl}.`,
    );
  }
  return params.persisted;
}

export type RelayHostEngineDeps = Readonly<{
  installRemoteComponent: RemoteInstaller;
  localInstallPolicy?: Readonly<{
    runServiceCommands?: boolean;
    skipHealthCheck?: boolean;
  }>;
  resolveLocalInstallVersion?: (params: Readonly<{
    channel: PublicReleaseRingId;
    mode: 'user' | 'system';
    serverBinaryPath: string;
  }>) => Promise<string | null>;
  now?: () => number;
} & RemoteDeps>;

export type RelayHostEngine = Readonly<{
  readStatus: (params: RelayRuntimeTaskParams) => Promise<RelayRuntimeStatusSnapshot>;
  installOrUpdate: (params: RelayRuntimeTaskParams) => Promise<Readonly<{
    relayUrl: string;
    mode: 'user' | 'system';
    purpose?: ManagedRelayPurpose;
    canonicalServerUrl?: string;
    layout?: PersonalHomeRuntimeLayout;
  }>>;
  /** Ordinary start/stop are transient runtime controls; activate/quarantine change durable service authority. */
  control: (params: RelayRuntimeTaskParams & Readonly<{
    action: 'start' | 'stop' | 'restart' | 'uninstall' | 'activate' | 'quarantine';
  }>) => Promise<void>;
}>;

const LOCAL_RELAY_STATUS_HEALTH_TIMEOUT_MS = 1_000;
const LOCAL_RELAY_CONTROL_HEALTH_TIMEOUT_MS = 120_000;
const RELAY_RUNTIME_CHANNELS: readonly PublicReleaseRingId[] = ['stable', 'preview', 'publicdev'];
function quoteRemoteShellArg(value: string): string {
  const raw = String(value ?? '');
  if (raw === '') return "''";
  const trimmed = raw.trim();
  if (
    trimmed.startsWith('$HOME')
    && /^[A-Za-z0-9$._/-]+$/u.test(trimmed)
  ) {
    return trimmed;
  }
  return `'${raw.replaceAll("'", `'\"'\"'`)}'`;
}

function sanitizeRemotePathSegment(value: string): string {
  const sanitized = String(value ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-');
  return sanitized || 'payload';
}

async function readRecentLocalRelayStderr(stderrPath: string): Promise<string> {
  const text = await readFile(stderrPath, 'utf8').catch(() => '');
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  return lines.slice(-80).join('\n');
}

async function assertLocalRelayRuntimeHealthy(params: Readonly<{
  relayUrl: string;
  healthPath: string;
  stderrPath: string;
}>): Promise<void> {
  const healthy = await resolveLocalRelayHealth({
    baseUrl: params.relayUrl,
    healthPath: params.healthPath,
    timeoutMs: LOCAL_RELAY_CONTROL_HEALTH_TIMEOUT_MS,
  }).catch(() => false);
  if (healthy) {
    return;
  }

  const tailText = await readRecentLocalRelayStderr(params.stderrPath);
  const message = [
    `Local relay runtime did not become healthy at ${params.relayUrl}.`,
    tailText ? `Recent stderr:\n${tailText}` : '',
  ].filter(Boolean).join('\n');
  throw new Error(message);
}

function normalizeChannel(raw: unknown): PublicReleaseRingId {
  return normalizePublicReleaseRingId(raw) || 'stable';
}

function normalizeMode(raw: unknown): 'user' | 'system' {
  return String(raw ?? '').trim().toLowerCase() === 'system' ? 'system' : 'user';
}

function formatRelayChannelLabel(channel: PublicReleaseRingId): 'stable' | 'preview' | 'dev' {
  return channel === 'publicdev' ? 'dev' : channel;
}

function listOtherRelayChannels(channel: PublicReleaseRingId): readonly PublicReleaseRingId[] {
  return RELAY_RUNTIME_CHANNELS.filter((candidate) => candidate !== channel);
}

function resolveRemoteHomeDirForRuntime(): string {
  return '$HOME';
}

function resolveRemoteHomeDirForComponents(): string {
  return '$HOME/.happier';
}

function buildRelayRuntimeServiceSpec(params: Readonly<{
  label: string;
  installRoot: string;
  serverBinaryPath: string;
  env: Record<string, string>;
  stdoutPath: string;
  stderrPath: string;
}>): ServiceSpec {
  return {
    label: params.label,
    description: `Happier Relay Runtime (${params.label})`,
    programArgs: [params.serverBinaryPath],
    workingDirectory: params.installRoot,
    env: params.env,
    stdoutPath: params.stdoutPath,
    stderrPath: params.stderrPath,
  };
}

async function resolveRemoteUserHomeDir(
  deps: Pick<RemoteDeps, 'runRemoteText'>,
  params: Readonly<{ ssh: SystemTaskSshConnectionConfig; knownHostsMode?: 'app' | 'system' }>,
): Promise<string | null> {
  const result = await deps.runRemoteText({
    ssh: params.ssh,
    knownHostsMode: params.knownHostsMode,
    remoteCommand: `printf '%s\\n' \"$HOME\"`,
  }).catch(() => ({ status: 1, stdout: '', stderr: '' }));
  const candidate = result.status === 0 ? String(result.stdout ?? '').trim() : '';
  return candidate.startsWith('/') ? candidate : null;
}

function resolveRemotePlatform(params: Readonly<{ target: RemoteReleaseTarget }>): 'linux' | 'darwin' {
  return params.target.os;
}

function resolveRelayDefaultsForRemote(params: Readonly<{
  platform: 'linux' | 'darwin';
  channel: PublicReleaseRingId;
  mode: 'user' | 'system';
}>): RelayRuntimeDefaults {
  const homeDir = params.mode === 'system' ? '' : resolveRemoteHomeDirForRuntime();
  return resolveRelayRuntimeDefaults({
    platform: params.platform,
    channel: params.channel,
    mode: params.mode,
    homeDir,
  });
}

async function probeLocalPortOpen(params: Readonly<{ host: string; port: number; timeoutMs: number }>): Promise<boolean> {
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

async function fetchLocalJson(params: Readonly<{ url: string; timeoutMs: number }>): Promise<{
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

async function resolveLocalRelayHealth(params: Readonly<{
  baseUrl: string;
  healthPath: string;
  timeoutMs?: number;
}>): Promise<boolean> {
  const parsedUrl = new URL(params.baseUrl);
  const port = Number.parseInt(parsedUrl.port, 10);
  const result = await checkRelayRuntimeHealth({
    host: parsedUrl.hostname,
    port: Number.isInteger(port) && port > 0 ? port : 80,
    path: params.healthPath,
    timeoutMs: params.timeoutMs ?? LOCAL_RELAY_STATUS_HEALTH_TIMEOUT_MS,
    probePortOpen: async ({ host, port: localPort, timeoutMs }) => await probeLocalPortOpen({ host, port: localPort, timeoutMs }),
    fetchJson: async ({ url, timeoutMs }) => await fetchLocalJson({ url, timeoutMs }),
  });
  return result.reachable;
}

async function resolveLocalDesiredRelayUrl(params: Readonly<{
  mode: 'user' | 'system';
  channel: PublicReleaseRingId;
  envOverrides?: Record<string, string>;
  purpose?: ManagedRelayPurpose;
  freshPersonalHome: boolean;
  allowFreshPersonalHomePortReplanning: boolean;
}>): Promise<string> {
  const defaults = resolveRelayRuntimeDefaults({
    platform: process.platform,
    mode: params.mode,
    channel: params.channel,
    homeDir: homedir(),
  });
  const envPath = join(defaults.configDir, 'server.env');
  const existingEnvText = existsSync(envPath) ? await readFile(envPath, 'utf8').catch(() => '') : '';
  const existingPortRaw = existingEnvText ? String(parseEnvText(existingEnvText).PORT ?? '').trim() : '';
  const overridePortRaw = String((params.envOverrides ?? {}).PORT ?? '').trim();
  const purposePortRaw = params.purpose?.kind === 'personal-home'
    ? String(new URL(params.purpose.canonicalServerUrl).port || '').trim()
    : '';
  if (params.purpose?.kind === 'personal-home' && !purposePortRaw) {
    throw new Error('Personal Home canonicalServerUrl must include its stable port');
  }
  if (purposePortRaw && overridePortRaw && purposePortRaw !== overridePortRaw) {
    throw new Error('Personal Home PORT must match canonicalServerUrl');
  }
  if (purposePortRaw && existingPortRaw && purposePortRaw !== existingPortRaw) {
    throw new Error('Personal Home canonicalServerUrl does not match the persisted runtime port');
  }
  const provisionalPersonalHomeDefault = params.freshPersonalHome
    && params.allowFreshPersonalHomePortReplanning
    && params.purpose?.kind === 'personal-home'
    && !overridePortRaw
    && !existingPortRaw
    && Number.parseInt(purposePortRaw, 10) === defaults.serverPort;
  const configuredPortRaw = provisionalPersonalHomeDefault
    ? ''
    : purposePortRaw || overridePortRaw || existingPortRaw;
  const configuredPort = configuredPortRaw && Number.isInteger(Number.parseInt(configuredPortRaw, 10))
    ? Number.parseInt(configuredPortRaw, 10)
    : null;
  const resolvedPort = await resolveNonCollidingRelayPort({
    platform: process.platform,
    mode: params.mode,
    channel: params.channel,
    homeDir: homedir(),
    defaultPort: provisionalPersonalHomeDefault
      ? Number.parseInt(purposePortRaw, 10)
      : defaults.serverPort,
    configuredPort,
    explicitConfiguredPort: Boolean(overridePortRaw || (purposePortRaw && !provisionalPersonalHomeDefault)),
  });
  const baseEnvText = renderSelfHostServerEnvTextFromResolvedValues({
    port: resolvedPort,
    host: defaults.serverHost,
    dataDir: defaults.dataDir,
    filesDir: join(defaults.dataDir, 'files'),
    dbDir: join(defaults.dataDir, 'pglite'),
    databaseUrl: renderRelaySqliteDatabaseUrl({
      dbPath: join(defaults.dataDir, 'happier-server-light.sqlite'),
      platform: process.platform,
      env: { ...process.env, ...parseEnvText(existingEnvText), ...(params.envOverrides ?? {}) },
    }),
    sqliteAutoMigrate: resolveSelfHostSqliteAutoMigrateValue(),
    sqliteMigrationsDir: join(defaults.dataDir, 'migrations', 'sqlite'),
  });
  const envText = mergeSelfHostServerEnvText({
    baseEnvText,
    existingEnvText,
    overrides: {
      ...(params.envOverrides ?? {}),
      PORT: String(resolvedPort),
    },
  });
  const resolvedBaseUrl = resolveConfiguredSelfHostBaseUrl({
    fallbackBaseUrl: `http://${defaults.serverHost}:${resolvedPort}`,
    envText,
  });
  if (params.purpose?.kind === 'personal-home') {
    if (!provisionalPersonalHomeDefault) return params.purpose.canonicalServerUrl;
    const plannedUrl = new URL(params.purpose.canonicalServerUrl);
    plannedUrl.port = String(resolvedPort);
    return plannedUrl.toString().replace(/\/$/u, '');
  }
  return resolvedBaseUrl;
}


function createRelayLaneConflictError(params: Readonly<{
  requestedChannel: PublicReleaseRingId;
  conflictingChannel: PublicReleaseRingId;
  relayUrl: string;
}>): Error {
  return new Error(
    `A ${formatRelayChannelLabel(params.conflictingChannel)} relay is already installed at ${params.relayUrl}. `
    + 'Relay lanes keep separate data and are not replaced automatically. '
    + `Use --channel ${formatRelayChannelLabel(params.conflictingChannel)} to manage that relay, choose a different PORT, or uninstall it before installing ${formatRelayChannelLabel(params.requestedChannel)}.`,
  );
}

async function resolveRemoteRelayHealth(params: Readonly<{
  deps: RelayHostEngineDeps;
  ssh: SystemTaskSshConnectionConfig;
  knownHostsMode: 'app' | 'system';
  relayUrl: string;
  healthPath: string;
}>): Promise<boolean> {
  const probeResult = await params.deps.runRemoteText({
    ssh: params.ssh,
    knownHostsMode: params.knownHostsMode,
    remoteCommand: buildRelayRuntimeHealthProbeCommand({
      baseUrl: params.relayUrl,
      path: params.healthPath,
      maxAttempts: 1,
      sleepSeconds: 0,
    }),
  }).catch(() => ({ status: 1, stdout: '', stderr: '' }));
  const probeStdout = String(probeResult.stdout ?? '');
  return probeResult.status === 0 || probeStdout.includes(RELAY_RUNTIME_HEALTH_OK_TOKEN);
}


function buildRemoteProbeExistsCommand(params: Readonly<{ path: string; kind: 'file' | 'dir' }>): string {
  const testFlag = params.kind === 'dir' ? '-d' : '-f';
  return `if [ ${testFlag} ${quoteRemoteShellArg(params.path)} ]; then echo yes; fi`;
}


function buildRemoteReadJsonFileCommand(path: string): string {
  const quoted = quoteRemoteShellArg(path);
  return `if [ -f ${quoted} ]; then cat ${quoted}; else echo ''; fi`;
}

function buildRemoteReadTextFileCommand(params: Readonly<{ path: string; privilegedPrefix?: string }>): string {
  const quoted = quoteRemoteShellArg(params.path);
  const prefix = String(params.privilegedPrefix ?? '').trim();
  const cat = prefix ? `${prefix}cat` : 'cat';
  return `if [ -f ${quoted} ]; then ${cat} ${quoted} 2>/dev/null || true; else echo ''; fi`;
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isStrictRemoteRelayHostUninstallSuccessEnvelope(stdout: string): boolean {
  const envelope = tryParseJsonObject(stdout);
  if (!envelope) return false;
  const envelopeKeys = Object.keys(envelope).sort();
  if (envelopeKeys.join('\0') !== ['data', 'kind', 'ok', 'v'].join('\0')) return false;
  if (
    envelope.v !== 1
    || envelope.ok !== true
    || envelope.kind !== 'relay_host_uninstall'
    || !envelope.data
    || typeof envelope.data !== 'object'
    || Array.isArray(envelope.data)
  ) {
    return false;
  }
  const data = envelope.data as Record<string, unknown>;
  return Object.keys(data).length === 1 && data.ok === true;
}

function buildRemoteServiceStatusCommand(params: Readonly<{ backend: ServiceBackend; serviceName: string }>): string {
  const svc = `${params.serviceName}.service`;
  if (params.backend === 'systemd-user') {
    return wrapRemoteSystemdUserCommand(`systemctl --user show ${quoteRemoteShellArg(svc)} --property=UnitFileState,ActiveState,SubState`);
  }
  if (params.backend === 'systemd-system') {
    return `systemctl show ${quoteRemoteShellArg(svc)} --property=UnitFileState,ActiveState,SubState`;
  }
  if (params.backend === 'launchd-user' || params.backend === 'launchd-system') {
    return `launchctl list ${quoteRemoteShellArg(params.serviceName)}`;
  }
  throw new Error(`Unsupported remote backend: ${params.backend}`);
}

function wrapRemoteSystemdUserCommand(command: string): string {
  return `XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" DBUS_SESSION_BUS_ADDRESS="\${DBUS_SESSION_BUS_ADDRESS:-unix:path=\${XDG_RUNTIME_DIR}/bus}" ${command}`;
}

function parseSystemctlShowOutput(stdout: string): Readonly<{ unitFileState: string; activeState: string; subState: string; loadState: string }> {
  const lines = String(stdout ?? '').split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const map = new Map<string, string>();
  const rawValues: string[] = [];

  for (const line of lines) {
    const eqIndex = line.indexOf('=');
    if (eqIndex > 0) {
      const key = line.slice(0, eqIndex).trim().toLowerCase();
      const value = line.slice(eqIndex + 1).trim();
      if (key) {
        map.set(key, value);
      }
      continue;
    }
    rawValues.push(line);
  }

  const unitFileState = map.get('unitfilestate') ?? rawValues[0] ?? '';
  const activeState = map.get('activestate') ?? rawValues[1] ?? '';
  const subState = map.get('substate') ?? rawValues[2] ?? '';
  const loadState = map.get('loadstate') ?? '';
  return { unitFileState, activeState, subState, loadState };
}

function normalizeComparablePathKey(value: string | null | undefined): string | null {
  const trimmed = String(value ?? '').trim().replace(/[\\/]+$/, '');
  return trimmed || null;
}

function normalizeRemoteServiceSnapshot(params: Readonly<{
  backend: ServiceBackend;
  commandResult: RelayHostRemoteCommandResult;
}>): RelayRuntimeStatusSnapshot['service'] {
  if (params.backend === 'systemd-user' || params.backend === 'systemd-system') {
    if (params.commandResult.status !== 0) {
      return { enabled: null, active: null };
    }
    const { unitFileState, activeState } = parseSystemctlShowOutput(params.commandResult.stdout);
    return {
      enabled: unitFileState.trim().toLowerCase() === 'enabled',
      active: activeState.trim().toLowerCase() === 'active',
      // no "installed" field in snapshot shape
    };
  }
  if (params.backend === 'launchd-user' || params.backend === 'launchd-system') {
    const loaded = params.commandResult.status === 0;
    return {
      enabled: loaded,
      active: loaded,
    };
  }
  return { enabled: null, active: null };
}

function buildRemoteControlCommand(params: Readonly<{ backend: ServiceBackend; serviceName: string; action: 'start' | 'stop' | 'restart' }>): string {
  const svc = `${params.serviceName}.service`;
  if (params.backend === 'systemd-user') {
    return wrapRemoteSystemdUserCommand(`systemctl --user ${params.action} ${quoteRemoteShellArg(svc)}`);
  }
  if (params.backend === 'systemd-system') {
    const sudoSetup = "SUDO_PREFIX=''; if [ \"$(id -u)\" -ne 0 ]; then SUDO_PREFIX=\"sudo -n \"; fi; ";
    return `${sudoSetup}${'${SUDO_PREFIX}'}systemctl ${params.action} ${quoteRemoteShellArg(svc)}`;
  }
  if (params.backend === 'launchd-user' || params.backend === 'launchd-system') {
    const sudoSetup = params.backend === 'launchd-system'
      ? "SUDO_PREFIX=''; if [ \"$(id -u)\" -ne 0 ]; then SUDO_PREFIX=\"sudo -n \"; fi; "
      : '';
    const privilegedPrefix = params.backend === 'launchd-system' ? '${SUDO_PREFIX}' : '';
    if (params.action === 'stop') {
      return `${sudoSetup}${privilegedPrefix}launchctl unload -w ${quoteRemoteShellArg(resolveLaunchdPlistPath(params.serviceName, params.backend === 'launchd-system'))}`;
    }
    const plistPath = resolveLaunchdPlistPath(params.serviceName, params.backend === 'launchd-system');
    const launchdDomain = params.backend === 'launchd-system' ? 'system' : 'gui/$(id -u)';
    const serviceDomain = `${launchdDomain}/${params.serviceName}`;
    return `${sudoSetup}${privilegedPrefix}launchctl bootout -w ${quoteRemoteShellArg(plistPath)} 2>/dev/null || true; ${privilegedPrefix}launchctl bootstrap ${launchdDomain} ${quoteRemoteShellArg(plistPath)}; ${privilegedPrefix}launchctl enable ${quoteRemoteShellArg(serviceDomain)}; ${privilegedPrefix}launchctl kickstart -k ${quoteRemoteShellArg(serviceDomain)}`;
  }
  throw new Error(`Unsupported remote backend: ${params.backend}`);
}

function resolveLaunchdPlistPath(label: string, system: boolean): string {
  return system
    ? `/Library/LaunchDaemons/${label}.plist`
    : `${resolveRemoteHomeDirForRuntime()}/Library/LaunchAgents/${label}.plist`;
}

function resolveSystemdUnitDefinitionPath(params: Readonly<{
  backend: 'systemd-user' | 'systemd-system';
  unitName: string;
  homeDir: string;
}>): string {
  const filename = `${params.unitName}.service`;
  if (params.backend === 'systemd-system') {
    return join('/etc/systemd/system', filename);
  }
  return join(params.homeDir, '.config', 'systemd', 'user', filename);
}

function resolveLaunchdPlistDefinitionPath(params: Readonly<{
  backend: 'launchd-user' | 'launchd-system';
  label: string;
  homeDir: string;
}>): string {
  const filename = `${params.label}.plist`;
  if (params.backend === 'launchd-system') {
    return join('/Library/LaunchDaemons', filename);
  }
  return join(params.homeDir, 'Library', 'LaunchAgents', filename);
}

function resolveWindowsWrapperDefinitionPath(params: Readonly<{
  backend: 'schtasks-user' | 'schtasks-system';
  label: string;
  homeDir: string;
}>): string {
  if (params.backend === 'schtasks-system') {
    return `C:\\ProgramData\\happier\\services\\${params.label}.ps1`;
  }
  return `${params.homeDir}\\.happier\\services\\${params.label}.ps1`;
}

function parseSystemdUnitWorkingDirectory(unitText: string): string | null {
  const lines = String(unitText ?? '').split(/\r?\n/u);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    if (!trimmed.toLowerCase().startsWith('workingdirectory=')) continue;
    const value = trimmed.slice('WorkingDirectory='.length).trim();
    return value || null;
  }
  return null;
}

function parseSystemdUnitEnvironmentText(unitText: string): string {
  const entries: string[] = [];
  for (const line of String(unitText ?? '').split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    if (!trimmed.toLowerCase().startsWith('environment=')) continue;
    const raw = trimmed.slice('Environment='.length).trim();
    if (!raw) continue;
    const unquoted = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')
      ? raw.slice(1, -1)
      : raw;
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/u.test(unquoted)) continue;
    entries.push(unquoted);
  }
  return entries.join('\n');
}

function xmlUnescape(value: string): string {
  return String(value ?? '')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&');
}

function parseLaunchdPlistWorkingDirectory(plistText: string): string | null {
  const match = String(plistText ?? '').match(/<key>\s*WorkingDirectory\s*<\/key>\s*<string>([\s\S]*?)<\/string>/iu);
  const value = match?.[1]?.trim();
  return value ? xmlUnescape(value) : null;
}

function parseWindowsWrapperWorkingDirectory(wrapperText: string): string | null {
  const match = String(wrapperText ?? '').match(/Set-Location\s+-LiteralPath\s+"((?:`.|[^"])*)"/iu);
  return match ? parsePowerShellQuotedText(`"${match[1]}"`).trim() || null : null;
}

function parseServiceDefinitionWorkingDirectory(params: Readonly<{
  backend: ServiceBackend;
  definitionText: string;
}>): string | null {
  if (params.backend === 'systemd-user' || params.backend === 'systemd-system') {
    return parseSystemdUnitWorkingDirectory(params.definitionText);
  }
  if (params.backend === 'launchd-user' || params.backend === 'launchd-system') {
    return parseLaunchdPlistWorkingDirectory(params.definitionText);
  }
  if (params.backend === 'schtasks-user' || params.backend === 'schtasks-system') {
    return parseWindowsWrapperWorkingDirectory(params.definitionText);
  }
  return null;
}

function resolveServiceDefinitionBaseUrl(params: Readonly<{
  backend: ServiceBackend;
  definitionText: string;
  fallbackBaseUrl: string;
}>): string | null {
  if (params.backend !== 'systemd-user' && params.backend !== 'systemd-system') {
    return null;
  }
  const envText = parseSystemdUnitEnvironmentText(params.definitionText);
  if (!envText.trim()) return null;
  return resolveConfiguredSelfHostBaseUrl({
    fallbackBaseUrl: params.fallbackBaseUrl,
    envText,
  });
}

type LocalRelayStrandedLegacyState = Readonly<{
  legacyInstallRoot: string;
  currentInstallRoot: string;
}>;

async function readComparableFileHash(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  const contents = await readFile(path).catch(() => null);
  if (!contents) return null;
  return createHash('sha256').update(contents).digest('hex');
}

function renderLocalRelayStrandedLegacyStateMessage(params: Readonly<{
  channel: PublicReleaseRingId;
  legacyInstallRoot: string;
  currentInstallRoot: string;
}>): string {
  return `Detected older ${formatRelayChannelLabel(params.channel)} relay state at ${params.legacyInstallRoot} beside the current relay root ${params.currentInstallRoot}. `
    + 'The two roots use different data secrets, so auth/session data may be split between them. '
    + 'Automatic recovery is unsafe once both roots exist; inspect or restore the older root before reinstalling or reauthenticating this relay.';
}

function relayRuntimeStateMatchesRequestedLane(params: Readonly<{
  state: Record<string, unknown>;
  channel: PublicReleaseRingId;
  mode: 'user' | 'system';
}>): boolean {
  const stateChannel = String(params.state.channel ?? '').trim();
  const stateMode = String(params.state.mode ?? '').trim();
  const channelMatches = stateChannel === params.channel
    || (params.channel === 'publicdev' && stateChannel === 'dev');
  const modeMatches = !stateMode || stateMode === params.mode;
  return channelMatches && modeMatches;
}

async function detectLocalRelayStrandedLegacyState(params: Readonly<{
  backend: ServiceBackend;
  channel: PublicReleaseRingId;
  defaults: RelayRuntimeDefaults;
  currentBaseUrl: string;
}>): Promise<LocalRelayStrandedLegacyState | null> {
  if (params.channel === 'stable') return null;
  if (params.backend !== 'systemd-user' && params.backend !== 'systemd-system') return null;

  const legacyDefinitionPath = resolveSystemdUnitDefinitionPath({
    backend: params.backend,
    unitName: 'happier-server',
    homeDir: homedir(),
  });
  if (!existsSync(legacyDefinitionPath)) return null;

  const legacyText = await readFile(legacyDefinitionPath, 'utf8').catch(() => '');
  if (!legacyText.trim()) return null;

  const legacyInstallRoot = parseSystemdUnitWorkingDirectory(legacyText);
  const legacyKey = normalizeComparablePathKey(legacyInstallRoot);
  const currentKey = normalizeComparablePathKey(params.defaults.installRoot);
  if (!legacyKey || !currentKey || legacyKey === currentKey) return null;
  const resolvedLegacyInstallRoot = legacyKey;

  const legacyBaseUrl = resolveServiceDefinitionBaseUrl({
    backend: params.backend,
    definitionText: legacyText,
    fallbackBaseUrl: params.currentBaseUrl,
  });
  if (legacyBaseUrl !== params.currentBaseUrl) return null;

  const legacyStatePath = join(resolvedLegacyInstallRoot, 'self-host-state.json');
  if (existsSync(legacyStatePath)) {
    const legacyStateText = await readFile(legacyStatePath, 'utf8').catch(() => '');
    const legacyState = tryParseJsonObject(legacyStateText);
    if (legacyState && !relayRuntimeStateMatchesRequestedLane({
      state: legacyState,
      channel: params.channel,
      mode: params.defaults.mode,
    })) {
      return null;
    }
  }

  const legacyDbPath = join(resolvedLegacyInstallRoot, 'data', 'happier-server-light.sqlite');
  const currentDbPath = join(params.defaults.dataDir, 'happier-server-light.sqlite');
  if (!existsSync(legacyDbPath) || !existsSync(currentDbPath)) return null;

  const legacySecretHash = await readComparableFileHash(join(resolvedLegacyInstallRoot, 'data', 'handy-master-secret.txt'));
  const currentSecretHash = await readComparableFileHash(join(params.defaults.dataDir, 'handy-master-secret.txt'));
  if (!legacySecretHash || !currentSecretHash || legacySecretHash === currentSecretHash) return null;

  return {
    legacyInstallRoot: resolvedLegacyInstallRoot,
    currentInstallRoot: params.defaults.installRoot,
  };
}

function resolveRemoteServiceDefinitionPath(params: Readonly<{
  backend: ServiceBackend;
  label: string;
  remoteHomeDir: string;
}>): string {
  if (params.backend === 'systemd-system') {
    return `/etc/systemd/system/${params.label}.service`;
  }
  if (params.backend === 'systemd-user') {
    return `${params.remoteHomeDir}/.config/systemd/user/${params.label}.service`;
  }
  if (params.backend === 'launchd-system') {
    return `/Library/LaunchDaemons/${params.label}.plist`;
  }
  if (params.backend === 'launchd-user') {
    return `${params.remoteHomeDir}/Library/LaunchAgents/${params.label}.plist`;
  }
  throw new Error(`Unsupported backend: ${params.backend}`);
}


export function createRelayHostEngine(deps: RelayHostEngineDeps): RelayHostEngine {
  const now = deps.now ?? (() => Date.now());

  const runLocalText = (cmd: string, args: readonly string[]) => {
    const res = spawnBackgroundSync(cmd, [...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildServiceCommandEnv({ cmd, args, env: process.env }),
    });
    return {
      status: typeof res.status === 'number' ? res.status : 1,
      stdout: String(res.stdout ?? ''),
      stderr: `${String(res.stderr ?? '')}${res.error instanceof Error ? `\n${res.error.message}` : ''}`.trim(),
    };
  };

  const resolveLocalSystemdUnitOwnedByInstallRoot = async (params: Readonly<{
    backend: 'systemd-user' | 'systemd-system';
    unitName: string;
    installRoot: string;
  }>): Promise<boolean> => {
    const unitPath = resolveSystemdUnitDefinitionPath({
      backend: params.backend,
      unitName: params.unitName,
      homeDir: homedir(),
    });
    const unitText = existsSync(unitPath) ? await readFile(unitPath, 'utf8').catch(() => '') : '';
    const workingDir = parseSystemdUnitWorkingDirectory(unitText);
    const workingDirKey = normalizeComparablePathKey(workingDir);
    const installRootKey = normalizeComparablePathKey(params.installRoot);
    return Boolean(workingDirKey && installRootKey && workingDirKey === installRootKey);
  };

  const resolveLocalLaunchdPlistOwnedByInstallRoot = async (params: Readonly<{
    backend: 'launchd-user' | 'launchd-system';
    label: string;
    installRoot: string;
  }>): Promise<boolean> => {
    const plistPath = resolveLaunchdPlistDefinitionPath({
      backend: params.backend,
      label: params.label,
      homeDir: homedir(),
    });
    const plistText = existsSync(plistPath) ? await readFile(plistPath, 'utf8').catch(() => '') : '';
    const workingDir = parseLaunchdPlistWorkingDirectory(plistText);
    const workingDirKey = normalizeComparablePathKey(workingDir);
    const installRootKey = normalizeComparablePathKey(params.installRoot);
    return Boolean(workingDirKey && installRootKey && workingDirKey === installRootKey);
  };

  const materializeRemoteHomeDir = (remoteHomeDir: string, value: string): string => {
    const raw = String(value ?? '');
    if (!raw) return raw;
    if (remoteHomeDir.startsWith('/') && raw.includes('$HOME')) {
      return raw.replaceAll('$HOME', remoteHomeDir);
    }
    return raw;
  };

  const resolveRemoteSystemdUnitState = async (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    knownHostsMode: 'app' | 'system';
    backend: 'systemd-user' | 'systemd-system';
    unitName: string;
  }>): Promise<Readonly<{ loadState: string; activeState: string }>> => {
    const svc = `${params.unitName}.service`;
    const remoteCommand = params.backend === 'systemd-user'
      ? wrapRemoteSystemdUserCommand(`systemctl --user show ${quoteRemoteShellArg(svc)} --property=LoadState,ActiveState`)
      : `systemctl show ${quoteRemoteShellArg(svc)} --property=LoadState,ActiveState`;
    const result = await deps.runRemoteText({
      ssh: params.ssh,
      knownHostsMode: params.knownHostsMode,
      remoteCommand,
    }).catch(() => ({ status: 1, stdout: '', stderr: '' }));
    if (result.status !== 0) return { loadState: 'not-found', activeState: '' };
    const parsed = parseSystemctlShowOutput(String(result.stdout ?? ''));
    const loadState = parsed.loadState.trim().toLowerCase();
    const activeState = parsed.activeState.trim().toLowerCase();
    return { loadState: loadState || 'not-found', activeState };
  };

  const resolveRemoteSystemdUnitOwnedByInstallRoot = async (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    knownHostsMode: 'app' | 'system';
    backend: 'systemd-user' | 'systemd-system';
    unitName: string;
    remoteHomeDir: string;
    installRoot: string;
  }>): Promise<boolean> => {
    const unitPath = resolveRemoteServiceDefinitionPath({
      backend: params.backend,
      label: params.unitName,
      remoteHomeDir: params.remoteHomeDir,
    });
    const privilegedPrefix = params.backend === 'systemd-system' ? 'sudo -n ' : '';
    const unitText = await deps.runRemoteText({
      ssh: params.ssh,
      knownHostsMode: params.knownHostsMode,
      remoteCommand: buildRemoteReadTextFileCommand({ path: unitPath, privilegedPrefix }),
    }).then((result) => String(result.stdout ?? '')).catch(() => '');
    const workingDir = parseSystemdUnitWorkingDirectory(unitText);
    const workingDirKey = normalizeComparablePathKey(materializeRemoteHomeDir(params.remoteHomeDir, String(workingDir ?? '')));
    const installRootKey = normalizeComparablePathKey(materializeRemoteHomeDir(params.remoteHomeDir, params.installRoot));
    return Boolean(workingDirKey && installRootKey && workingDirKey === installRootKey);
  };

  const resolveRemoteLaunchdServiceState = async (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    knownHostsMode: 'app' | 'system';
    backend: 'launchd-user' | 'launchd-system';
    label: string;
  }>): Promise<Readonly<{ loadState: string; activeState: string }>> => {
    const sudoSetup = params.backend === 'launchd-system'
      ? "SUDO_PREFIX=''; if [ \"$(id -u)\" -ne 0 ]; then SUDO_PREFIX=\"sudo -n \"; fi; "
      : '';
    const privilegedPrefix = params.backend === 'launchd-system' ? '${SUDO_PREFIX}' : '';
    const result = await deps.runRemoteText({
      ssh: params.ssh,
      knownHostsMode: params.knownHostsMode,
      remoteCommand: `${sudoSetup}${privilegedPrefix}launchctl list ${quoteRemoteShellArg(params.label)}`,
    }).catch(() => ({ status: 1, stdout: '', stderr: '' }));
    return result.status === 0
      ? { loadState: 'loaded', activeState: 'active' }
      : { loadState: 'not-found', activeState: '' };
  };

  const resolveRemoteLaunchdPlistOwnedByInstallRoot = async (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    knownHostsMode: 'app' | 'system';
    backend: 'launchd-user' | 'launchd-system';
    label: string;
    remoteHomeDir: string;
    installRoot: string;
  }>): Promise<boolean> => {
    const plistPath = resolveRemoteServiceDefinitionPath({
      backend: params.backend,
      label: params.label,
      remoteHomeDir: params.remoteHomeDir,
    });
    const privilegedPrefix = params.backend === 'launchd-system' ? 'sudo -n ' : '';
    const plistText = await deps.runRemoteText({
      ssh: params.ssh,
      knownHostsMode: params.knownHostsMode,
      remoteCommand: buildRemoteReadTextFileCommand({ path: plistPath, privilegedPrefix }),
    }).then((result) => String(result.stdout ?? '')).catch(() => '');
    const workingDir = parseLaunchdPlistWorkingDirectory(plistText);
    const workingDirKey = normalizeComparablePathKey(materializeRemoteHomeDir(params.remoteHomeDir, String(workingDir ?? '')));
    const installRootKey = normalizeComparablePathKey(materializeRemoteHomeDir(params.remoteHomeDir, params.installRoot));
    return Boolean(workingDirKey && installRootKey && workingDirKey === installRootKey);
  };

  const resolveRemoteEffectiveServiceName = async (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    knownHostsMode: 'app' | 'system';
    backend: ServiceBackend;
    channel: PublicReleaseRingId;
    remoteHomeDir: string;
    defaults: RelayRuntimeDefaults;
  }>): Promise<string> => {
    if (
      params.backend !== 'systemd-user'
      && params.backend !== 'systemd-system'
      && params.backend !== 'launchd-user'
      && params.backend !== 'launchd-system'
    ) {
      return params.defaults.serviceName;
    }
    if (params.channel === 'stable') {
      return params.defaults.serviceName;
    }

    const legacyUnitName = 'happier-server';
    const legacyOwnedByInstallRoot = params.backend === 'systemd-user' || params.backend === 'systemd-system'
      ? await resolveRemoteSystemdUnitOwnedByInstallRoot({
        ssh: params.ssh,
        knownHostsMode: params.knownHostsMode,
        backend: params.backend,
        unitName: legacyUnitName,
        remoteHomeDir: params.remoteHomeDir,
        installRoot: params.defaults.installRoot,
      }).catch(() => false)
      : await resolveRemoteLaunchdPlistOwnedByInstallRoot({
        ssh: params.ssh,
        knownHostsMode: params.knownHostsMode,
        backend: params.backend,
        label: legacyUnitName,
        remoteHomeDir: params.remoteHomeDir,
        installRoot: params.defaults.installRoot,
      }).catch(() => false);
    if (!legacyOwnedByInstallRoot) {
      return params.defaults.serviceName;
    }

    const canonicalState = params.backend === 'systemd-user' || params.backend === 'systemd-system'
      ? await resolveRemoteSystemdUnitState({
        ssh: params.ssh,
        knownHostsMode: params.knownHostsMode,
        backend: params.backend,
        unitName: params.defaults.serviceName,
      }).catch(() => ({ loadState: 'not-found', activeState: '' }))
      : await resolveRemoteLaunchdServiceState({
        ssh: params.ssh,
        knownHostsMode: params.knownHostsMode,
        backend: params.backend,
        label: params.defaults.serviceName,
      }).catch(() => ({ loadState: 'not-found', activeState: '' }));
    if (canonicalState.loadState === 'not-found') {
      return legacyUnitName;
    }

    const canonicalOwnedByInstallRoot = params.backend === 'systemd-user' || params.backend === 'systemd-system'
      ? await resolveRemoteSystemdUnitOwnedByInstallRoot({
        ssh: params.ssh,
        knownHostsMode: params.knownHostsMode,
        backend: params.backend,
        unitName: params.defaults.serviceName,
        remoteHomeDir: params.remoteHomeDir,
        installRoot: params.defaults.installRoot,
      }).catch(() => false)
      : await resolveRemoteLaunchdPlistOwnedByInstallRoot({
        ssh: params.ssh,
        knownHostsMode: params.knownHostsMode,
        backend: params.backend,
        label: params.defaults.serviceName,
        remoteHomeDir: params.remoteHomeDir,
        installRoot: params.defaults.installRoot,
      }).catch(() => false);
    if (!canonicalOwnedByInstallRoot) {
      return legacyUnitName;
    }

    const legacyState = params.backend === 'systemd-user' || params.backend === 'systemd-system'
      ? await resolveRemoteSystemdUnitState({
        ssh: params.ssh,
        knownHostsMode: params.knownHostsMode,
        backend: params.backend,
        unitName: legacyUnitName,
      }).catch(() => ({ loadState: 'not-found', activeState: '' }))
      : await resolveRemoteLaunchdServiceState({
        ssh: params.ssh,
        knownHostsMode: params.knownHostsMode,
        backend: params.backend,
        label: legacyUnitName,
      }).catch(() => ({ loadState: 'not-found', activeState: '' }));
    const canonicalActive = canonicalState.activeState === 'active';
    const legacyActive = legacyState.activeState === 'active';
    if (canonicalActive !== legacyActive) {
      return legacyActive ? legacyUnitName : params.defaults.serviceName;
    }

    return params.defaults.serviceName;
  };

  const resolveLocalSystemdUnitState = (params: Readonly<{
    backend: 'systemd-user' | 'systemd-system';
    unitName: string;
  }>): Readonly<{ loadState: string; activeState: string; enabledState: string }> => {
    const prefix = params.backend === 'systemd-user' ? ['--user'] : [];
    const result = runLocalText('systemctl', [
      ...prefix,
      'show',
      `${params.unitName}.service`,
      '--property=UnitFileState,ActiveState,SubState,LoadState',
    ]);
    if (result.status !== 0) {
      return { loadState: 'indeterminate', activeState: '', enabledState: '' };
    }
    const parsed = parseSystemctlShowOutput(result.stdout);
    return {
      loadState: parsed.loadState.trim().toLowerCase() || 'not-found',
      activeState: parsed.activeState.trim().toLowerCase(),
      enabledState: parsed.unitFileState.trim().toLowerCase(),
    };
  };

  const resolveLocalLaunchdServiceState = (params: Readonly<{
    backend: 'launchd-user' | 'launchd-system';
    label: string;
  }>): Readonly<{ loadState: string; activeState: string; enabledState: string }> => {
    type LaunchdListProbe =
      | Readonly<{ kind: 'loaded' }>
      | Readonly<{ kind: 'absent' }>
      | Readonly<{ kind: 'indeterminate' }>;
    const probeLaunchdList = (): LaunchdListProbe => {
      const result = runLocalText('launchctl', ['list', params.label]);
      if (result.status === 0) return { kind: 'loaded' };
      const output = `${result.stdout}\n${result.stderr}`;
      if (/could not find (?:specified )?service|service.*not found/iu.test(output)) {
        return { kind: 'absent' };
      }
      return { kind: 'indeterminate' };
    };

    const listProbe = probeLaunchdList();
    if (listProbe.kind === 'indeterminate') {
      return { loadState: 'indeterminate', activeState: '', enabledState: '' };
    }
    const definitionPath = resolveLaunchdPlistDefinitionPath({
      backend: params.backend,
      label: params.label,
      homeDir: homedir(),
    });
    const loaded = listProbe.kind === 'loaded';
    const registered = loaded || existsSync(definitionPath);
    if (!registered) return { loadState: 'not-found', activeState: '', enabledState: '' };

    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    const domain = params.backend === 'launchd-system' ? 'system' : uid != null ? `gui/${uid}` : '';
    const disabledSnapshot = domain ? runLocalText('launchctl', ['print-disabled', domain]) : null;
    const escapedLabel = params.label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const disabledMatch = disabledSnapshot?.status === 0
      ? new RegExp(`"?${escapedLabel}"?\\s*=>\\s*(true|false)`, 'iu').exec(disabledSnapshot.stdout)
      : null;
    const disabled = disabledMatch?.[1]?.toLowerCase() === 'true';
    return {
      loadState: 'loaded',
      activeState: loaded ? 'active' : 'inactive',
      enabledState: disabled ? 'disabled' : 'enabled',
    };
  };

  const resolveLocalWindowsScheduledTaskState = (params: Readonly<{
    label: string;
  }>): Readonly<{ loadState: string; activeState: string; enabledState: string }> => {
    const result = runLocalText('schtasks', ['/Query', '/TN', `Happier\\${params.label}`, '/FO', 'LIST', '/V']);
    const powerShellStatus = runLocalText('powershell.exe', [
      '-NoProfile',
      '-Command',
      buildReadWindowsScheduledTaskStatusPowerShellCommand({
        taskName: params.label,
      }),
    ]);
    const parsedPowerShellStatus = powerShellStatus.status === 0
      ? parseWindowsScheduledTaskStatusPowerShellJson(powerShellStatus.stdout)
      : null;
    if (parsedPowerShellStatus) {
      return parsedPowerShellStatus.exists
        ? {
            loadState: 'loaded',
            activeState: parsedPowerShellStatus.active ? 'active' : 'inactive',
            enabledState: parsedPowerShellStatus.enabled ? 'enabled' : 'disabled',
          }
        : { loadState: 'not-found', activeState: '', enabledState: '' };
    }
    if (result.status !== 0) {
      return { loadState: 'indeterminate', activeState: '', enabledState: '' };
    }
    const output = `${result.stdout}\n${result.stderr}`;
    return {
      loadState: 'loaded',
      activeState: /Status:\s*Running/i.test(output) ? 'active' : 'inactive',
      enabledState: /Scheduled Task State:\s*Enabled/i.test(output) ? 'enabled' : 'disabled',
    };
  };

  type LocalServiceState = Readonly<{
    loadState: string;
    activeState: string;
    enabledState: string;
  }>;

  const resolveLocalServiceState = (params: Readonly<{
    backend: ServiceBackend;
    label: string;
  }>): LocalServiceState => {
    if (params.backend === 'systemd-user' || params.backend === 'systemd-system') {
      return resolveLocalSystemdUnitState({ backend: params.backend, unitName: params.label });
    }
    if (params.backend === 'launchd-user' || params.backend === 'launchd-system') {
      return resolveLocalLaunchdServiceState({ backend: params.backend, label: params.label });
    }
    return resolveLocalWindowsScheduledTaskState({ label: params.label });
  };

  const projectLocalServiceState = (state: LocalServiceState): RelayRuntimeStatusSnapshot['service'] => {
    if (state.loadState === 'not-found' || state.loadState === 'indeterminate') {
      return { enabled: null, active: null };
    }
    return {
      enabled: state.enabledState === 'enabled',
      active: state.activeState === 'active',
    };
  };

  const classifyLocalServiceTerminalState = (
    state: LocalServiceState,
  ): RelayHostLifecyclePostconditionError['terminalState'] => {
    if (state.loadState === 'indeterminate') return 'indeterminate';
    if (state.loadState === 'not-found') return 'deregistered';
    return state.activeState === 'active' ? 'active' : 'registered-inactive';
  };

  const resolveLocalServiceOwnedByInstallRoot = async (params: Readonly<{
    backend: ServiceBackend;
    label: string;
    installRoot: string;
  }>): Promise<boolean> => {
    if (params.backend === 'systemd-user' || params.backend === 'systemd-system') {
      return resolveLocalSystemdUnitOwnedByInstallRoot({
        backend: params.backend,
        unitName: params.label,
        installRoot: params.installRoot,
      });
    }
    if (params.backend === 'launchd-user' || params.backend === 'launchd-system') {
      return resolveLocalLaunchdPlistOwnedByInstallRoot({
        backend: params.backend,
        label: params.label,
        installRoot: params.installRoot,
      });
    }
    if (params.backend === 'schtasks-user' || params.backend === 'schtasks-system') {
      const definitionPath = resolveWindowsWrapperDefinitionPath({
        backend: params.backend,
        label: params.label,
        homeDir: homedir(),
      });
      const definitionText = existsSync(definitionPath) ? await readFile(definitionPath, 'utf8').catch(() => '') : '';
      const workingDir = parseWindowsWrapperWorkingDirectory(definitionText);
      const workingDirKey = normalizeComparablePathKey(workingDir);
      const installRootKey = normalizeComparablePathKey(params.installRoot);
      return Boolean(workingDirKey && installRootKey && workingDirKey === installRootKey);
    }
    return false;
  };

  const resolveLocalEffectiveServiceName = async (params: Readonly<{
    backend: ServiceBackend;
    channel: PublicReleaseRingId;
    defaults: RelayRuntimeDefaults;
  }>): Promise<string> => {
    if (params.channel === 'stable') {
      return params.defaults.serviceName;
    }
    if (
      params.backend !== 'systemd-user'
      && params.backend !== 'systemd-system'
      && params.backend !== 'launchd-user'
      && params.backend !== 'launchd-system'
      && params.backend !== 'schtasks-user'
      && params.backend !== 'schtasks-system'
    ) {
      return params.defaults.serviceName;
    }

    const legacyUnitName = 'happier-server';
    const legacyOwnedByInstallRoot = await resolveLocalServiceOwnedByInstallRoot({
      backend: params.backend,
      label: legacyUnitName,
      installRoot: params.defaults.installRoot,
    }).catch(() => false);
    if (!legacyOwnedByInstallRoot) {
      return params.defaults.serviceName;
    }

    const readState = (label: string) => {
      if (params.backend === 'systemd-user' || params.backend === 'systemd-system') {
        return resolveLocalSystemdUnitState({
          backend: params.backend,
          unitName: label,
        });
      }
      if (params.backend === 'launchd-user' || params.backend === 'launchd-system') {
        return resolveLocalLaunchdServiceState({
          backend: params.backend,
          label,
        });
      }
      return resolveLocalWindowsScheduledTaskState({ label });
    };

    const canonicalState = readState(params.defaults.serviceName);
    if (canonicalState.loadState === 'not-found') {
      return legacyUnitName;
    }

    const canonicalOwnedByInstallRoot = await resolveLocalServiceOwnedByInstallRoot({
      backend: params.backend,
      label: params.defaults.serviceName,
      installRoot: params.defaults.installRoot,
    }).catch(() => false);
    if (!canonicalOwnedByInstallRoot) {
      return legacyUnitName;
    }

    const legacyState = readState(legacyUnitName);
    const canonicalActive = canonicalState.activeState === 'active';
    const legacyActive = legacyState.activeState === 'active';
    if (canonicalActive !== legacyActive) {
      return legacyActive ? legacyUnitName : params.defaults.serviceName;
    }

    return params.defaults.serviceName;
  };

  async function readLocalStatus(parsed: RelayRuntimeTaskParams): Promise<RelayRuntimeStatusSnapshot> {
    const mode = normalizeMode(parsed.mode);
    const channel = normalizeChannel(parsed.channel);
    const defaults = resolveRelayRuntimeDefaults({
      platform: process.platform,
      mode,
      channel,
      homeDir: homedir(),
    });
    const serverBinaryName = process.platform === 'win32' ? 'happier-server.exe' : 'happier-server';
    const statePath = join(defaults.installRoot, 'self-host-state.json');
    const installBinaryPath = join(defaults.installRoot, 'bin', serverBinaryName);
    const stateText = existsSync(statePath) ? await readFile(statePath, 'utf8').catch(() => '') : '';
    const state = stateText.trim() ? tryParseJsonObject(stateText) : null;
    const version = typeof state?.version === 'string' ? state.version : null;

    const backend = resolveServiceBackend({
      platform: process.platform,
      mode,
    }) as ServiceBackend;
    const effectiveServiceName = await resolveLocalEffectiveServiceName({
      backend,
      channel,
      defaults,
    });

    const service = projectLocalServiceState(resolveLocalServiceState({
      backend,
      label: effectiveServiceName,
    }));
    const installed = Boolean(version) || existsSync(installBinaryPath);
    // Installed runtime classification is owner metadata. A caller may request Personal Home
    // facts for an absent runtime, but it must not relabel an already-installed generic Home.
    const runtimePurpose = parsePersistedManagedRelayPurpose(state?.purpose)
      ?? (!installed ? parsed.purpose : undefined);
    const envPath = join(defaults.configDir, 'server.env');
    const envText = existsSync(envPath) ? await readFile(envPath, 'utf8').catch(() => '') : '';
    const defaultBaseUrl = `http://${defaults.serverHost}:${defaults.serverPort}`;
    let baseUrl = resolveConfiguredSelfHostBaseUrl({
      // Persisted Personal Home purpose remains the canonical origin authority when erase or
      // recovery removes the managed environment but intentionally retains classification.
      fallbackBaseUrl: runtimePurpose?.kind === 'personal-home'
        ? runtimePurpose.canonicalServerUrl
        : defaultBaseUrl,
      envText,
    });
    if (!installed && !envText.trim()) {
      if (runtimePurpose?.kind !== 'personal-home') {
        const plannedPort = await resolveNonCollidingRelayPort({
          platform: process.platform,
          mode,
          channel,
          homeDir: homedir(),
          defaultPort: defaults.serverPort,
          configuredPort: null,
        });
        baseUrl = `http://${defaults.serverHost}:${plannedPort}`;
      }
    }
    const healthy = service.active === true
      ? await resolveLocalRelayHealth({
        baseUrl,
        healthPath: defaults.healthPath,
        timeoutMs: LOCAL_RELAY_STATUS_HEALTH_TIMEOUT_MS,
      }).catch(() => false)
      : service.active === null
        ? null
        : false;
    const strandedLegacyState = await detectLocalRelayStrandedLegacyState({
      backend,
      channel,
      defaults,
      currentBaseUrl: baseUrl,
    });

    const personalHomeLayout = await resolvePersistedLocalPersonalHomeLayout({
      defaults,
      homeDir: homedir(),
      platform: process.platform,
    });
    const personalHomeDataPresent = await hasMeaningfulPersonalHomeData(personalHomeLayout);
    const personalHomeSignupPolicy = runtimePurpose?.kind === 'personal-home'
      ? readEffectivePersonalHomeSignupPolicy(envText)
      : undefined;

    return {
      installed,
      version,
      service,
      baseUrl,
      healthy,
      ...(strandedLegacyState ? {
        warnings: [renderLocalRelayStrandedLegacyStateMessage({
          channel,
          legacyInstallRoot: strandedLegacyState.legacyInstallRoot,
          currentInstallRoot: strandedLegacyState.currentInstallRoot,
        })],
      } : {}),
      ...(runtimePurpose ? { purpose: runtimePurpose } : {}),
      dataPresent: personalHomeDataPresent,
      ...(runtimePurpose?.kind === 'personal-home' ? {
        canonicalServerUrl: runtimePurpose.canonicalServerUrl,
        ...(personalHomeLayout ? { layout: personalHomeLayout } : {}),
        anonymousSignupEnabled: personalHomeSignupPolicy === 'enabled'
          ? true
          : personalHomeSignupPolicy === 'disabled'
            ? false
            : null,
      } : {}),
    };
  }

  async function installLocal(parsed: RelayRuntimeTaskParams): Promise<Readonly<{
    relayUrl: string;
    mode: 'user' | 'system';
    purpose?: ManagedRelayPurpose;
    canonicalServerUrl?: string;
    layout?: PersonalHomeRuntimeLayout;
  }>> {
    const mode = normalizeMode(parsed.mode);
    const channel = normalizeChannel(parsed.channel);
    const defaults = resolveRelayRuntimeDefaults({
      platform: process.platform,
      mode,
      channel,
      homeDir: homedir(),
    });
    const persistedPurpose = await readPersistedManagedRelayPurpose(defaults);
    const mutationLayout = await resolvePersistedLocalPersonalHomeLayout({
      defaults,
      homeDir: homedir(),
      platform: process.platform,
    });
    const preservedHomeDataPresent = await hasMeaningfulPersonalHomeData(mutationLayout);
    if (preservedHomeDataPresent && !persistedPurpose) {
      await assertExplicitPersonalHomeMatchesPreservedConfiguration({ defaults, requested: parsed.purpose });
    }
    let purpose = resolveEffectiveLocalMutationPurpose({
      persisted: persistedPurpose,
      requested: parsed.purpose,
    });
    const desiredRelayUrl = await resolveLocalDesiredRelayUrl({
      mode,
      channel,
      envOverrides: parsed.env,
      purpose,
      freshPersonalHome: persistedPurpose === undefined && !preservedHomeDataPresent,
      allowFreshPersonalHomePortReplanning: parsed.expectedPersonalHomeState === undefined,
    });
    if (purpose?.kind === 'personal-home' && purpose.canonicalServerUrl !== desiredRelayUrl) {
      purpose = { kind: 'personal-home', canonicalServerUrl: desiredRelayUrl };
    }
    const backend = resolveServiceBackend({ platform: process.platform, mode }) as ServiceBackend;
    const effectiveServiceName = await resolveLocalEffectiveServiceName({ backend, channel, defaults });
    const shouldTreatStableLaneAsLegacyUnsuffixedInstall = await shouldMigrateLegacyUnsuffixedRelayRuntimeInstallRoot({
      platform: process.platform,
      mode,
      channel,
      homeDir: homedir(),
    });
    const ignoreStableLaneConflict = await (async () => {
      if (channel === 'stable') return false;
      if (
        backend !== 'systemd-user'
        && backend !== 'systemd-system'
        && backend !== 'launchd-user'
        && backend !== 'launchd-system'
      ) return false;
      const legacyUnitName = 'happier-server';
      const legacyDefinitionPath = backend === 'systemd-user' || backend === 'systemd-system'
        ? resolveSystemdUnitDefinitionPath({ backend, unitName: legacyUnitName, homeDir: homedir() })
        : resolveLaunchdPlistDefinitionPath({ backend, label: legacyUnitName, homeDir: homedir() });
      const legacyText = existsSync(legacyDefinitionPath) ? await readFile(legacyDefinitionPath, 'utf8').catch(() => '') : '';
      if (!legacyText.trim()) return false;
      const legacyWorkingDir = parseServiceDefinitionWorkingDirectory({ backend, definitionText: legacyText });
      const legacyWorkingDirKey = normalizeComparablePathKey(legacyWorkingDir);
      const installRootKey = normalizeComparablePathKey(defaults.installRoot);
      return Boolean(legacyWorkingDirKey && installRootKey && legacyWorkingDirKey === installRootKey);
    })();
    await (async () => {
      if (channel === 'stable') return;
      if (backend !== 'systemd-user' && backend !== 'systemd-system') return;
      const legacyUnitName = 'happier-server';
      const legacyDefinitionPath = resolveSystemdUnitDefinitionPath({
        backend,
        unitName: legacyUnitName,
        homeDir: homedir(),
      });
      if (!existsSync(legacyDefinitionPath)) return;
      const legacyText = await readFile(legacyDefinitionPath, 'utf8').catch(() => '');
      if (!legacyText.trim()) return;

      const legacyWorkingDir = parseServiceDefinitionWorkingDirectory({ backend, definitionText: legacyText });
      const legacyWorkingDirKey = normalizeComparablePathKey(legacyWorkingDir);
      const installRootKey = normalizeComparablePathKey(defaults.installRoot);
      if (legacyWorkingDirKey && installRootKey && legacyWorkingDirKey === installRootKey) return;

      const prefix = backend === 'systemd-user' ? ['--user'] : [];
      const legacyShow = runLocalText('systemctl', [
        ...prefix,
        'show',
        `${legacyUnitName}.service`,
        '--property=ActiveState,SubState,LoadState',
      ]);
      const legacyState = legacyShow.status === 0
        ? parseSystemctlShowOutput(legacyShow.stdout)
        : null;
      const legacyLoaded = legacyState?.loadState.trim().toLowerCase() === 'loaded';
      const legacyActive = legacyState?.activeState.trim().toLowerCase() === 'active';
      if (!legacyLoaded || !legacyActive) return;

      const legacyBaseUrl = resolveServiceDefinitionBaseUrl({
        backend,
        definitionText: legacyText,
        fallbackBaseUrl: `http://${defaults.serverHost}:${defaults.serverPort}`,
      });
      if (legacyBaseUrl !== desiredRelayUrl) return;

      throw new Error(
        `An active legacy happier-server.service is already using ${desiredRelayUrl} from ${legacyWorkingDir ?? 'an unknown root'}. `
        + `Stop or uninstall that legacy service before installing the ${formatRelayChannelLabel(channel)} relay.`,
      );
    })();
    const strandedLegacyState = await detectLocalRelayStrandedLegacyState({
      backend,
      channel,
      defaults,
      currentBaseUrl: desiredRelayUrl,
    });
    if (strandedLegacyState) {
      throw new Error(renderLocalRelayStrandedLegacyStateMessage({
        channel,
        legacyInstallRoot: strandedLegacyState.legacyInstallRoot,
        currentInstallRoot: strandedLegacyState.currentInstallRoot,
      }));
    }
    for (const otherChannel of listOtherRelayChannels(channel)) {
      if (otherChannel === 'stable' && shouldTreatStableLaneAsLegacyUnsuffixedInstall) continue;
      if (otherChannel === 'stable' && ignoreStableLaneConflict) continue;
      const otherStatus = await readLocalStatus({
        ...parsed,
        channel: formatRelayChannelLabel(otherChannel),
      });
      const otherLaneOccupiesDesiredUrl =
        otherStatus.baseUrl === desiredRelayUrl
        && (
          otherStatus.installed
          || otherStatus.service.active === true
          || otherStatus.service.enabled === true
        );
      if (otherLaneOccupiesDesiredUrl) {
        throw createRelayLaneConflictError({
          requestedChannel: channel,
          conflictingChannel: otherChannel,
          relayUrl: desiredRelayUrl,
        });
      }
    }
    const serverBinaryPath = typeof parsed.selfHostRelayBinaryOverride === 'string'
      ? parsed.selfHostRelayBinaryOverride.trim()
      : '';
    if (!serverBinaryPath) {
      throw new Error('Local relay runtime install requires selfHostRelayBinaryOverride.');
    }
    const version = deps.resolveLocalInstallVersion
      ? await deps.resolveLocalInstallVersion({ channel, mode, serverBinaryPath })
      : null;
    const policy = deps.localInstallPolicy ?? {};

    const cleanupLegacyServiceBeforeInstall = async (): Promise<void> => {
      if (channel === 'stable') return undefined;
      if (backend !== 'systemd-user' && backend !== 'systemd-system' && backend !== 'launchd-user' && backend !== 'launchd-system') return undefined;

      const legacyUnitName = 'happier-server';
      const legacyDefinitionPath = backend === 'systemd-user' || backend === 'systemd-system'
        ? resolveSystemdUnitDefinitionPath({ backend, unitName: legacyUnitName, homeDir: homedir() })
        : resolveLaunchdPlistDefinitionPath({ backend, label: legacyUnitName, homeDir: homedir() });
      if (!existsSync(legacyDefinitionPath)) return undefined;

      const legacyText = await readFile(legacyDefinitionPath, 'utf8').catch(() => '');
      const legacyWorkingDir = parseServiceDefinitionWorkingDirectory({ backend, definitionText: legacyText });
      const legacyOwnedByInstallRoot =
        normalizeComparablePathKey(legacyWorkingDir) !== null
        && normalizeComparablePathKey(legacyWorkingDir) === normalizeComparablePathKey(defaults.installRoot);
      if (!legacyOwnedByInstallRoot) return undefined;

      if (backend === 'systemd-user' || backend === 'systemd-system') {
        const prefix = backend === 'systemd-user' ? ['--user'] : [];
        if (policy.runServiceCommands !== false) {
          runLocalText('systemctl', [...prefix, 'disable', '--now', `${legacyUnitName}.service`]);
        }
        await rm(legacyDefinitionPath, { force: true }).catch(() => undefined);
        if (policy.runServiceCommands !== false) {
          runLocalText('systemctl', [...prefix, 'daemon-reload']);
        }
        return undefined;
      }

      if (policy.runServiceCommands !== false) {
        runLocalText('launchctl', ['unload', '-w', legacyDefinitionPath]);
        runLocalText('launchctl', ['remove', legacyUnitName]);
      }
      await rm(legacyDefinitionPath, { force: true }).catch(() => undefined);
      return undefined;
    };

    const resolvedPortFromDesiredUrl = (() => {
      try {
        const parsedUrl = new URL(desiredRelayUrl);
        const value = Number.parseInt(parsedUrl.port, 10);
        return Number.isInteger(value) && value > 0 && value <= 65_535 ? String(value) : null;
      } catch {
        return null;
      }
    })();
    const envForInstaller: Record<string, string> = {
      ...(parsed.env ?? {}),
      ...(resolvedPortFromDesiredUrl && !(parsed.env ?? {}).PORT ? { PORT: resolvedPortFromDesiredUrl } : {}),
    };
    const resolvePersonalHomeUpgradeLayout = purpose?.kind === 'personal-home'
      ? async () => resolvePersistedLocalPersonalHomeLayout({
        defaults,
        homeDir: homedir(),
        platform: process.platform,
      })
      : null;
    const assertPersonalHomeMutationPrecondition = parsed.expectedPersonalHomeState
      ? async (): Promise<void> => {
        const expected = parsed.expectedPersonalHomeState!;
        // The precondition compares durable incumbent facts. Projecting the caller-requested
        // purpose onto an absent runtime would make every legitimate fresh install appear to
        // have raced from `canonicalServerUrl: null` to the requested URL before mutation.
        const status = await readLocalStatus({ ...parsed, purpose: undefined });
        const persistedCanonicalServerUrl = status.purpose?.kind === 'personal-home'
          ? status.purpose.canonicalServerUrl
          : null;
        if (
          status.installed !== expected.installed
          || persistedCanonicalServerUrl !== expected.canonicalServerUrl
          || status.dataPresent !== expected.dataPresent
        ) {
          throw new PersonalHomeBootstrapInterruptedError();
        }
        if (
          !expected.installed
          && expected.canonicalServerUrl === null
          && !expected.dataPresent
          && purpose?.kind === 'personal-home'
        ) {
          const fixedUrl = new URL(purpose.canonicalServerUrl);
          const fixedPort = Number.parseInt(fixedUrl.port, 10);
          const bindable = Number.isInteger(fixedPort)
            && fixedPort > 0
            && fixedPort <= 65_535
            && await isLocalRelayPortBindable({ host: fixedUrl.hostname, port: fixedPort });
          if (!bindable) throw new PersonalHomeBootstrapInterruptedError();
        }
      }
      : null;

    const local = await installOrUpdateRelayRuntimeLocal({
      serverBinaryPath,
      channel,
      mode,
      env: envForInstaller,
      ...(purpose ? { purpose } : {}),
      version,
      runServiceCommands: policy.runServiceCommands !== false,
      skipHealthCheck: policy.skipHealthCheck === true,
      cleanupLegacyServiceBeforeInstall,
      ...(assertPersonalHomeMutationPrecondition ? { assertPersonalHomeMutationPrecondition } : {}),
      ...(resolvePersonalHomeUpgradeLayout ? {
        resolvePersonalHomeUpdateLayout: resolvePersonalHomeUpgradeLayout,
        readPersonalHomeWasRunning: async () => (await readLocalStatus({ ...parsed, purpose })).service.active === true,
        assertPersonalHomeStopped: async () => {
          const serviceState = resolveLocalServiceState({ backend, label: effectiveServiceName });
          const terminalState = classifyLocalServiceTerminalState(serviceState);
          if (terminalState !== 'registered-inactive' && terminalState !== 'deregistered') {
            throw new RelayHostLifecyclePostconditionError({
              action: 'stop',
              service: projectLocalServiceState(serviceState),
              terminalState,
            });
          }
        },
        createPersonalHomeRestorePoint: async ({ happierVersion, layout }) => {
          if (!existsSync(layout.databasePath)) return null;
          if (!happierVersion) {
            throw new Error('Personal Home restore-point version is unavailable for an existing Home.');
          }
          const identity = await readCanonicalPersonalHomeIdentity(layout);
          return createPersonalHomeRestorePointWithLease({
            layout,
            ...identity,
            happierVersion,
            configuration: await readPersonalHomeSanitizedConfiguration(layout),
            sqlite: await createPersonalHomeSqliteMaintenance(layout.databasePath),
            readIdentityFromDatabase: readPersonalHomeIdentityValueFromSqlite,
            readDataCountsFromDatabase: readPersonalHomeDataCountsFromSqlite,
            finalizeConfiguration: (artifact) => finalizePersonalHomeSanitizedConfiguration(layout, artifact),
            recoverConfiguration: (artifact) => recoverPersonalHomeSanitizedConfiguration(layout, artifact),
            operationLeaseHeld: true,
          });
        },
        openPersonalHomeRestorePoint: async ({ archivePath, expectedHomeServerIdentityId, schemaVersion, layout }) => {
          return openPersonalHomeRestorePointWithLease({
            layout,
            archivePath,
            expectedHomeServerIdentityId,
            schemaVersion,
            readIdentityFromDatabase: readPersonalHomeIdentityValueFromSqlite,
            readDataCountsFromDatabase: readPersonalHomeDataCountsFromSqlite,
            finalizeConfiguration: (artifact) => finalizePersonalHomeSanitizedConfiguration(layout, artifact),
            recoverConfiguration: (artifact) => recoverPersonalHomeSanitizedConfiguration(layout, artifact),
            operationLeaseHeld: true,
          });
        },
        personalHomeRestoreHooks: {
          sqliteMaintenance: createPersonalHomeSqliteMaintenance,
          verifyIdentity: async (manifest) => {
            const identity = await readCanonicalPersonalHomeIdentity(await resolvePersonalHomeUpgradeLayout());
            return identity.homeServerIdentityId === manifest.homeServerIdentityId;
          },
          prepareConfiguration: async (configuration) => preparePersonalHomeSanitizedConfiguration(
            await resolvePersonalHomeUpgradeLayout(), configuration,
          ),
          inspectConfigurationStorage: async (configuration) => inspectPersonalHomeSanitizedConfigurationStorage(
            await resolvePersonalHomeUpgradeLayout(), configuration,
          ),
          readDataCountsFromDatabase: readPersonalHomeDataCountsFromSqlite,
          requireDataCountVerification: true,
        },
      } : {}),
    });

    return {
      relayUrl: String(local.baseUrl ?? '').trim() || `http://127.0.0.1:${defaults.serverPort}`,
      mode,
      ...(purpose ? {
        purpose,
        ...(purpose.kind === 'personal-home' ? {
          canonicalServerUrl: purpose.canonicalServerUrl,
          layout: await resolvePersistedLocalPersonalHomeLayout({
            defaults,
            homeDir: homedir(),
            platform: process.platform,
          }),
        } : {}),
      } : {}),
    };
  }

  async function uninstallLocal(parsed: RelayRuntimeTaskParams): Promise<void> {
    const mode = normalizeMode(parsed.mode);
    const channel = normalizeChannel(parsed.channel);
    const defaults = resolveRelayRuntimeDefaults({
      platform: process.platform,
      mode,
      channel,
      homeDir: homedir(),
    });
    const persistedPurpose = await readPersistedManagedRelayPurpose(defaults);
    const purpose = resolveEffectiveLocalMutationPurpose({
      persisted: persistedPurpose,
      requested: parsed.purpose,
    });
    const mutationLayout = await resolvePersistedLocalPersonalHomeLayout({
      defaults,
      homeDir: homedir(),
      platform: process.platform,
    });
    const personalHomeLayout = purpose?.kind === 'personal-home' || await hasMeaningfulPersonalHomeData(mutationLayout)
      ? mutationLayout
      : null;
    const serverBinaryName = process.platform === 'win32' ? 'happier-server.exe' : 'happier-server';
    const installServerBinaryPath = join(defaults.installRoot, 'bin', serverBinaryName);
    const statePath = join(defaults.installRoot, 'self-host-state.json');
    const persistedStateText = await readOptionalMutationAuthorityText(statePath);
    const persistedState = persistedStateText ? tryParseJsonObject(persistedStateText) : null;
    const retainedPersonalHomeVersion = typeof persistedState?.version === 'string' && persistedState.version.trim()
      ? persistedState.version.trim()
      : null;
    const stdoutPath = join(defaults.logDir, 'server.out.log');
    const stderrPath = join(defaults.logDir, 'server.err.log');
    const backend = resolveServiceBackend({ platform: process.platform, mode }) as ServiceBackend;
    const effectiveServiceName = await resolveLocalEffectiveServiceName({
      backend,
      channel,
      defaults,
    });
    const serviceSpec = buildRelayRuntimeServiceSpec({
      label: effectiveServiceName,
      installRoot: defaults.installRoot,
      serverBinaryPath: installServerBinaryPath,
      env: {},
      stdoutPath,
      stderrPath,
    });
    const definition = buildServiceDefinition({
      backend,
      homeDir: homedir(),
      spec: serviceSpec,
    });
    const plan = planServiceAction({
      backend,
      action: 'uninstall',
      label: serviceSpec.label,
      definitionPath: definition.path,
      persistent: true,
    });

    const uninstallRuntime = async (): Promise<void> => {
      await applyServicePlan(plan, {
        runCommands: true,
      });
      const terminalServiceState = resolveLocalServiceState({
        backend,
        label: effectiveServiceName,
      });
      const terminalState = classifyLocalServiceTerminalState(terminalServiceState);
      if (terminalState !== 'deregistered') {
        throw new RelayHostLifecyclePostconditionError({
          action: 'uninstall',
          service: projectLocalServiceState(terminalServiceState),
          terminalState,
        });
      }
      await uninstallRelayRuntimePayloadLocal({
        installRoot: defaults.installRoot,
        shimPath: join(defaults.binDir, serverBinaryName),
        statePath,
        logDir: defaults.logDir,
        ...(persistedPurpose?.kind === 'personal-home' ? { retainedPurpose: persistedPurpose } : {}),
        ...(persistedPurpose?.kind === 'personal-home' && retainedPersonalHomeVersion
          ? { retainedVersion: retainedPersonalHomeVersion }
          : {}),
      });
      if (persistedPurpose?.kind !== 'personal-home' && existsSync(statePath)) {
        throw new Error('Failed to remove relay runtime state file.');
      }
    };
    await withFirstPartyPayloadMutationLock({
      installRoot: defaults.installRoot,
      lockParentDir: dirname(defaults.installRoot),
      operation: async () => {
        if (personalHomeLayout) {
          await withPersonalHomeOperationAdmission({
            request: { kind: 'uninstall' },
            readValidatedTarget: async () => {
              const currentPurpose = resolveEffectiveLocalMutationPurpose({
                persisted: await readPersistedManagedRelayPurpose(defaults),
                requested: parsed.purpose,
              });
              const layout = await resolvePersistedLocalPersonalHomeLayout({ defaults, homeDir: homedir(), platform: process.platform });
              await validateCanonicalPersonalHomeLayout(layout, {
                homeDir: homedir(), installRoot: defaults.installRoot, configDir: defaults.configDir,
              });
              return {
                layout,
                canonicalServerUrl: currentPurpose?.kind === 'personal-home' ? currentPurpose.canonicalServerUrl : null,
                homeServerIdentityId: existsSync(layout.databasePath) ? (await readPersonalHomeIdentityValueFromSqlite(layout.databasePath)).homeServerIdentityId : null,
              };
            },
            isHomeRunning: async () => {
              const state = classifyLocalServiceTerminalState(resolveLocalServiceState({ backend, label: effectiveServiceName }));
              return state !== 'registered-inactive' && state !== 'deregistered';
            },
          }, uninstallRuntime);
          return;
        }
        await uninstallRuntime();
      },
    });
  }

  async function resolveRemoteTarget(ssh: SystemTaskSshConnectionConfig, knownHostsMode?: 'app' | 'system'): Promise<RemoteReleaseTarget> {
    return await deps.resolveRemoteReleaseTarget({ ssh, knownHostsMode });
  }

  async function readRemoteStatus(params: Readonly<{ parsed: RelayRuntimeTaskParams; ssh: SystemTaskSshConnectionConfig }>): Promise<RelayRuntimeStatusSnapshot> {
    const knownHostsMode: 'app' | 'system' = params.ssh.knownHostsPath ? 'app' : 'system';
    const target = await resolveRemoteTarget(params.ssh, knownHostsMode);
    const platform = resolveRemotePlatform({ target });
    const mode = normalizeMode(params.parsed.mode);
    const channel = normalizeChannel(params.parsed.channel);
    const defaults = resolveRelayDefaultsForRemote({ platform, channel, mode });
    const remoteHomeDir = await resolveRemoteUserHomeDir(deps, { ssh: params.ssh, knownHostsMode })
      ?? resolveRemoteHomeDirForRuntime();
    const statePath = `${defaults.installRoot}/self-host-state.json`;
    const envPath = `${defaults.configDir}/server.env`;

    const stateResult = await deps.runRemoteText({
      ssh: params.ssh,
      knownHostsMode,
      remoteCommand: buildRemoteReadJsonFileCommand(statePath),
    });
    const state = tryParseJsonObject(stateResult.stdout);
    const version = typeof state?.version === 'string' ? state.version : null;

    const backend = resolveServiceBackend({ platform, mode });
    const serviceName = await resolveRemoteEffectiveServiceName({
      ssh: params.ssh,
      knownHostsMode,
      backend,
      channel,
      remoteHomeDir,
      defaults,
    });
    const serviceResult = await deps.runRemoteText({
      ssh: params.ssh,
      knownHostsMode,
      remoteCommand: buildRemoteServiceStatusCommand({ backend, serviceName }),
    }).catch((error: unknown) => ({
      status: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : 'failed to read remote service status',
    }));

    const service = normalizeRemoteServiceSnapshot({
      backend,
      commandResult: serviceResult,
    });

    const installBinaryPath = `${defaults.installRoot}/bin/happier-server`;
    const binaryExists = await deps.runRemoteText({
      ssh: params.ssh,
      knownHostsMode,
      remoteCommand: buildRemoteProbeExistsCommand({ path: installBinaryPath, kind: 'file' }),
    }).then((result) => String(result.stdout ?? '').trim() === 'yes').catch(() => false);

    const privilegedPrefix = backend === 'systemd-system' || backend === 'launchd-system'
      ? 'sudo -n '
      : '';
    const envText = await deps.runRemoteText({
      ssh: params.ssh,
      knownHostsMode,
      remoteCommand: buildRemoteReadTextFileCommand({ path: envPath, privilegedPrefix }),
    }).then((result) => String(result.stdout ?? '')).catch(() => '');
    const baseUrl = resolveConfiguredSelfHostBaseUrl({
      fallbackBaseUrl: `http://${defaults.serverHost}:${defaults.serverPort}`,
      envText,
    });
    const healthy = service.active === true
      ? await resolveRemoteRelayHealth({
        deps,
        ssh: params.ssh,
        knownHostsMode,
        relayUrl: baseUrl,
        healthPath: defaults.healthPath,
      })
      : service.active === null
        ? null
        : false;

    return {
      installed: Boolean(version) || binaryExists,
      version,
      service,
      baseUrl,
      healthy,
    };
  }

  async function installRemote(params: Readonly<{ parsed: RelayRuntimeTaskParams; ssh: SystemTaskSshConnectionConfig }>): Promise<Readonly<{ relayUrl: string; mode: 'user' | 'system' }>> {
    const knownHostsMode: 'app' | 'system' = params.ssh.knownHostsPath ? 'app' : 'system';
    const channel = normalizeChannel(params.parsed.channel);
    const mode = normalizeMode(params.parsed.mode);

    await deps.installRemoteComponent({
      componentId: 'happier-cli',
      channel,
      ssh: params.ssh,
      knownHostsMode,
      remoteHomeDir: resolveRemoteHomeDirForComponents(),
      ...(params.parsed.signal ? { signal: params.parsed.signal } : {}),
    });

    const localServerOverride = typeof params.parsed.selfHostRelayBinaryOverride === 'string'
      ? params.parsed.selfHostRelayBinaryOverride.trim()
      : '';
    const uploadedServer = localServerOverride
      ? await deps.installRemoteComponent({
          componentId: 'happier-server',
          channel,
          ssh: params.ssh,
          knownHostsMode,
          remoteHomeDir: resolveRemoteHomeDirForComponents(),
          localBinaryPath: localServerOverride,
          ...(params.parsed.signal ? { signal: params.parsed.signal } : {}),
        })
      : null;

    const result = await deps.runRemoteText({
      ssh: params.ssh,
      knownHostsMode,
      remoteCommand: buildRemoteBootstrapCommand({
        label: 'relay.runtime.install',
        serverUrl: DEFAULT_HAPPIER_CLOUD_SERVER_URL,
        channel: formatRelayChannelLabel(channel),
        data: {
          relayRuntimeMode: mode,
          relayRuntimeEnv: params.parsed.env ?? {},
          ...(uploadedServer
            ? { relayRuntimeServerBinaryPath: uploadedServer.binaryPath }
            : {}),
        },
      }),
      ...(params.parsed.signal ? { signal: params.parsed.signal } : {}),
    });

    const envelope = parseJsonLinesBestEffort<{
      ok?: unknown;
      kind?: unknown;
      data?: { relayUrl?: unknown; mode?: unknown };
      error?: { message?: unknown };
    }>(result.stdout);
    if (result.status !== 0 || envelope?.ok !== true || envelope.kind !== 'relay_host_install') {
      const remoteMessage = typeof envelope?.error?.message === 'string'
        ? envelope.error.message.trim()
        : '';
      throw new Error(
        remoteMessage
        || result.stderr.trim()
        || 'Remote canonical relay installer failed',
      );
    }

    const relayUrl = typeof envelope.data?.relayUrl === 'string'
      ? envelope.data.relayUrl.trim()
      : '';
    const installedMode = envelope.data?.mode === 'system' ? 'system' : envelope.data?.mode === 'user' ? 'user' : null;
    if (!relayUrl || !installedMode) {
      throw new Error('Remote canonical relay installer returned an unsupported response');
    }

    return { relayUrl, mode: installedMode };
  }
  async function assertRemoteRelayRuntimeHealthy(params: Readonly<{
    deps: RelayHostEngineDeps;
    ssh: SystemTaskSshConnectionConfig;
    knownHostsMode: 'app' | 'system';
    backend: ServiceBackend;
    relayUrl: string;
    healthPath: string;
    stderrPath: string;
  }>): Promise<void> {
    const privilegedPrefix = params.backend === 'systemd-system' || params.backend === 'launchd-system'
      ? 'sudo -n '
      : '';
    const probeCommand = buildRelayRuntimeHealthProbeCommand({
      baseUrl: params.relayUrl,
      path: params.healthPath,
      maxAttempts: 120,
      sleepSeconds: 1,
    });

    const probeResult = await params.deps.runRemoteText({
      ssh: params.ssh,
      knownHostsMode: params.knownHostsMode,
      remoteCommand: probeCommand,
    });
    const probeStdout = String(probeResult.stdout ?? '');
    if (probeResult.status === 0 || probeStdout.includes(RELAY_RUNTIME_HEALTH_OK_TOKEN)) {
      return;
    }

    const tailResult = await params.deps.runRemoteText({
      ssh: params.ssh,
      knownHostsMode: params.knownHostsMode,
      remoteCommand: `${privilegedPrefix}tail -n 80 ${quoteRemoteShellArg(params.stderrPath)} 2>/dev/null || true`,
    }).catch(() => ({ status: 1, stdout: '', stderr: '' }));
    const tailText = String(tailResult.stdout ?? '').trim();
    const stderrDetail = probeResult.stderr.trim();
    const message = [
      `Remote relay runtime did not become healthy at ${params.relayUrl}.`,
      probeResult.status === 3 ? 'Missing curl/wget on the remote host (required for health checks).' : '',
      `Exit status: ${probeResult.status}`,
      stderrDetail ? `Probe error: ${stderrDetail}` : '',
      tailText ? `Recent stderr:\n${tailText}` : '',
    ].filter(Boolean).join('\n');
    throw new Error(message);
  }

  async function uninstallRemote(params: Readonly<{ parsed: RelayRuntimeTaskParams; ssh: SystemTaskSshConnectionConfig }>): Promise<void> {
    const knownHostsMode: 'app' | 'system' = params.ssh.knownHostsPath ? 'app' : 'system';
    const channel = normalizeChannel(params.parsed.channel);
    const mode = normalizeMode(params.parsed.mode);
    // Thin transport adapter: the installed remote Happier CLI (relay host uninstall) is the
    // canonical uninstall decision owner. It takes the remote Personal Home operation lock,
    // stops/unregisters the service, and removes only runtime-owned entries through the
    // runtime-owned allowlist while preserving the Home database, files, master secret and
    // configuration. The source side emits no service or deletion command of its own.
    const result = await deps.runRemoteText({
      ssh: params.ssh,
      knownHostsMode,
      remoteCommand: buildRemoteBootstrapCommand({
        label: 'relay.host.uninstall',
        serverUrl: DEFAULT_HAPPIER_CLOUD_SERVER_URL,
        channel: formatRelayChannelLabel(channel),
        data: { relayRuntimeMode: mode },
      }),
    });

    const envelope = parseJsonLinesBestEffort<{
      ok?: unknown;
      kind?: unknown;
      error?: { message?: unknown };
    }>(result.stdout);
    if (result.status !== 0 || !isStrictRemoteRelayHostUninstallSuccessEnvelope(result.stdout)) {
      const remoteMessage = typeof envelope?.error?.message === 'string'
        ? envelope.error.message.trim()
        : '';
      throw new Error(
        remoteMessage
        || [
          result.stderr.trim(),
          `Remote relay host uninstall did not report success (exit status ${result.status}). `
            + 'Ensure the installed Happier CLI is present on the remote host (for example via "happier relay host install --ssh <host>") and retry.',
        ].filter(Boolean).join(' '),
      );
    }
  }

  return {
    async readStatus(params) {
      const parsed = params;
      if (parsed.target.kind === 'ssh') {
        return await readRemoteStatus({ parsed, ssh: parsed.target.ssh });
      }
      return await readLocalStatus(parsed);
    },
    async installOrUpdate(params) {
      const parsed = params;
      if (parsed.target.kind === 'ssh') {
        return await installRemote({ parsed, ssh: parsed.target.ssh });
      }
      return await installLocal(parsed);
    },
    async control(params) {
      const parsed = params;
      if (!['start', 'stop', 'restart', 'uninstall', 'activate', 'quarantine'].includes(String(parsed.action))) {
        throw new Error(`Action '${String(parsed.action)}' is not supported by relay runtime control.`);
      }
      if (parsed.target.kind !== 'ssh') {
        if (parsed.action === 'uninstall') {
          await uninstallLocal(parsed);
          return;
        }
        const mode = normalizeMode(parsed.mode);
        const channel = normalizeChannel(parsed.channel);
        const defaults = resolveRelayRuntimeDefaults({
          platform: process.platform,
          mode,
          channel,
          homeDir: homedir(),
        });
        const persistedPurpose = await readPersistedManagedRelayPurpose(defaults);
        const mutationLayout = await resolvePersistedLocalPersonalHomeLayout({
          defaults,
          homeDir: homedir(),
          platform: process.platform,
        });
        const preservedHomeDataPresent = await hasMeaningfulPersonalHomeData(mutationLayout);
        if (preservedHomeDataPresent && !persistedPurpose && parsed.action !== 'stop' && parsed.action !== 'quarantine') {
          await assertExplicitPersonalHomeMatchesPreservedConfiguration({ defaults, requested: parsed.purpose });
        }
        const purpose = resolveEffectiveLocalMutationPurpose({
          persisted: persistedPurpose,
          requested: parsed.purpose,
        });
        const personalHomeLayout = purpose?.kind === 'personal-home' || preservedHomeDataPresent
          ? mutationLayout
          : null;
        const runLocalLifecycle = async (): Promise<void> => {
          if (personalHomeLayout && (parsed.action === 'start' || parsed.action === 'restart' || parsed.action === 'activate')) {
            await assertPersonalHomeRelocationSourceAllowsActivation(personalHomeLayout.dataDir);
            await assertPersonalHomeRelocationDestinationAllowsActivation(personalHomeLayout.dataDir);
          }
          const backend = resolveServiceBackend({ platform: process.platform, mode });
          const serviceName = await resolveLocalEffectiveServiceName({
            backend,
            channel,
            defaults,
          });
          const requiresFreshPersonalHomeReceipt = personalHomeLayout !== null
            && (parsed.action === 'start' || parsed.action === 'restart');
          const lifecycleEnvPath = personalHomeLayout
            ? join(personalHomeLayout.configDir, 'server.env')
            : join(defaults.configDir, 'server.env');
          const lifecycleEnvText = await readOptionalMutationAuthorityText(lifecycleEnvPath);
          const lifecycleEnv = parseEnvText(lifecycleEnvText);
          const lifecycleReceiptPath = personalHomeLayout
            ? join(personalHomeLayout.dataDir, 'startup-receipt.json')
            : '';
          const lifecycleReceiptNonce = requiresFreshPersonalHomeReceipt ? randomUUID() : '';
          const expectedPersonalHomeIdentity = requiresFreshPersonalHomeReceipt && personalHomeLayout
            ? (await readCanonicalPersonalHomeIdentity(personalHomeLayout)).homeServerIdentityId
            : '';
          if (requiresFreshPersonalHomeReceipt) await rm(lifecycleReceiptPath, { force: true });
          const ensureLocalRelayHealthy = async (): Promise<void> => {
            if (parsed.action !== 'start' && parsed.action !== 'restart' && parsed.action !== 'activate') {
              return;
            }
            const baseUrl = resolveConfiguredSelfHostBaseUrl({
              fallbackBaseUrl: `http://${defaults.serverHost}:${defaults.serverPort}`,
              envText: lifecycleEnvText,
            });
            await assertLocalRelayRuntimeHealthy({
              relayUrl: baseUrl,
              healthPath: defaults.healthPath,
              stderrPath: join(defaults.logDir, 'server.err.log'),
            });
            if (requiresFreshPersonalHomeReceipt) {
              const baseUrlObject = new URL(baseUrl);
              const receipt = await waitForRelayRuntimeStartupReceipt({
                path: lifecycleReceiptPath,
                nonce: lifecycleReceiptNonce,
              });
              if (receipt.host !== '127.0.0.1'
                || receipt.host !== baseUrlObject.hostname
                || receipt.port !== Number.parseInt(baseUrlObject.port, 10)
                || !receipt.readiness
                || receipt.readiness.homeServerIdentityId !== expectedPersonalHomeIdentity) {
                throw new Error('Personal Home lifecycle start did not produce a fresh matching startup receipt');
              }
            }
          };

          const serverBinaryName = process.platform === 'win32' ? 'happier-server.exe' : 'happier-server';
          const definition = buildServiceDefinition({
            backend,
            homeDir: homedir(),
            spec: buildRelayRuntimeServiceSpec({
              label: serviceName,
              installRoot: defaults.installRoot,
              serverBinaryPath: join(defaults.installRoot, 'bin', serverBinaryName),
              env: requiresFreshPersonalHomeReceipt ? {
                ...lifecycleEnv,
                HAPPIER_SERVER_STARTUP_RECEIPT_PATH: lifecycleReceiptPath,
                HAPPIER_SERVER_STARTUP_RECEIPT_NONCE: lifecycleReceiptNonce,
              } : {},
              stdoutPath: join(defaults.logDir, 'server.out.log'),
              stderrPath: join(defaults.logDir, 'server.err.log'),
            }),
          });
          const plan = planServiceAction({
            backend,
            action: parsed.action,
            label: serviceName,
            definitionPath: definition.path,
            ...(requiresFreshPersonalHomeReceipt ? { definitionContents: definition.contents } : {}),
            taskName: `Happier\\${serviceName}`,
            persistent: parsed.action === 'activate' || parsed.action === 'quarantine',
          });
          await applyServicePlan(plan, { runCommands: true });
          await ensureLocalRelayHealthy();
          if (parsed.action === 'stop') {
            const terminalServiceState = resolveLocalServiceState({ backend, label: serviceName });
            const terminalState = classifyLocalServiceTerminalState(terminalServiceState);
            if (terminalState !== 'registered-inactive' && terminalState !== 'deregistered') {
              throw new RelayHostLifecyclePostconditionError({
                action: 'stop',
                service: projectLocalServiceState(terminalServiceState),
                terminalState,
              });
            }
          }
          if (parsed.action === 'activate' || parsed.action === 'quarantine') {
            const status = await readLocalStatus(parsed);
            const postconditionMet = parsed.action === 'activate'
              ? status.service.enabled === true && status.service.active === true
              : status.service.enabled !== true && status.service.active !== true;
            if (!postconditionMet) {
              throw new Error(
                `Failed to ${parsed.action} relay runtime: service authority is enabled=${String(status.service.enabled)}, active=${String(status.service.active)}.`,
              );
            }
          }
        };
        // External Personal Home lifecycle mutations enter the incumbent Home operation lock;
        // a caller that already holds it in this process proceeds under it (lock-owner
        // reentrancy) instead of deadlocking against its own operation.
        if (personalHomeLayout) {
          await withPersonalHomeOperationLock(personalHomeLayout.dataDir, 'lifecycle', runLocalLifecycle);
          return;
        }
        await runLocalLifecycle();
        return;
      }
      const knownHostsMode: 'app' | 'system' = parsed.target.ssh.knownHostsPath ? 'app' : 'system';
      if (parsed.action === 'activate' || parsed.action === 'quarantine') {
        throw new Error(`Relay runtime ${parsed.action} must execute through the destination's installed local lifecycle owner.`);
      }
      if (parsed.action === 'uninstall') {
        await uninstallRemote({ parsed, ssh: parsed.target.ssh });
        return;
      }
      const target = await resolveRemoteTarget(parsed.target.ssh, knownHostsMode);
      const platform = resolveRemotePlatform({ target });
      const mode = normalizeMode(parsed.mode);
      const channel = normalizeChannel(parsed.channel);
      const defaults = resolveRelayDefaultsForRemote({ platform, channel, mode });
      const backend = resolveServiceBackend({ platform, mode });
      const result = await deps.runRemoteText({
        ssh: parsed.target.ssh,
        knownHostsMode,
        remoteCommand: buildRemoteControlCommand({
          backend,
          serviceName: defaults.serviceName,
          action: parsed.action,
        }),
      });
      if (result.status !== 0) {
        throw new Error(result.stderr.trim() || `Failed to ${parsed.action} relay runtime.`);
      }
      if (parsed.action === 'start' || parsed.action === 'restart') {
        const status = await readRemoteStatus({ parsed, ssh: parsed.target.ssh });
        await assertRemoteRelayRuntimeHealthy({
          deps,
          ssh: parsed.target.ssh,
          knownHostsMode,
          backend,
          relayUrl: status.baseUrl,
          healthPath: defaults.healthPath,
          stderrPath: `${defaults.logDir}/server.err.log`,
        });
      } else if (parsed.action === 'stop') {
        const status = await readRemoteStatus({ parsed, ssh: parsed.target.ssh });
        if (status.service.active !== false) {
          throw new RelayHostLifecyclePostconditionError({
            action: 'stop',
            service: status.service,
            terminalState: status.service.active === true ? 'active' : 'indeterminate',
          });
        }
      }
    },
  };
}
