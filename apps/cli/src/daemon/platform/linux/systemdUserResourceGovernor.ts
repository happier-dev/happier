import { getPriority } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { parseProcessOwnerTag, type ParsedProcessOwnerTag } from '@/processes/ownerTag';

import { execFileWithDeadline } from '@happier-dev/cli-common/process';
import type { MachineGuardStateV1 } from '@happier-dev/protocol/machines/guard/guardStateV1';
import {
  HAPPIER_CRITICAL_SLICE_MEMORY_LOW_BYTES,
  HAPPIER_CRITICAL_SLICE_NAME,
} from '@happier-dev/cli-common/service';

const SYSTEMD_USER_RESOURCE_GOVERNOR_PROBE_TIMEOUT_MS = 1_000;
const HAPPIER_JOBS_SLICE_NAME = 'happier-jobs.slice';

// systemd unit escaping is byte-based; '/' maps to '-' and literal '-' escapes.
function escapeScopeOwnerId(value: string): string {
  return [...Buffer.from(value)].map((byte, index) =>
    (byte >= 65 && byte <= 90 || byte >= 97 && byte <= 122 || byte >= 48 && byte <= 57
      || byte === 58 || byte === 95 || byte === 46 && index > 0)
      ? String.fromCharCode(byte) : byte === 47 ? '-' : `\\x${byte.toString(16).padStart(2, '0')}`,
  ).join('');
}

export function createHappierLinuxScopeName(ownerTag: string | undefined): string | undefined {
  const parsed = parseProcessOwnerTag(ownerTag);
  if (!parsed) return undefined;
  return `happier-${parsed.kind}-${parsed.daemonScopeKey}.${escapeScopeOwnerId(parsed.ownerId)}-${randomUUID().replaceAll('-', '')}.scope`;
}

export function parseHappierLinuxScopeName(scopeName: string): ParsedProcessOwnerTag | null {
  const match = /^happier-([a-z_]+)-([0-9a-f]{12})\.(.+)-([0-9a-f]{32})\.scope$/.exec(scopeName);
  if (!match) return null;
  const encoded = match[3]!;
  const bytes: number[] = [];
  for (let index = 0; index < encoded.length; index += 1) {
    const byte = encoded.charCodeAt(index);
    if (encoded[index] === '\\') {
      const escaped = /^\\x([0-9a-f]{2})/.exec(encoded.slice(index));
      if (!escaped) return null;
      bytes.push(Number.parseInt(escaped[1]!, 16));
      index += 3;
    } else {
      if (byte > 127) return null;
      bytes.push(byte === 45 ? 47 : byte);
    }
  }
  const ownerId = Buffer.from(bytes).toString('utf8');
  if (escapeScopeOwnerId(ownerId) !== encoded) return null;
  return parseProcessOwnerTag(`v1.${match[2]}.${match[1]}.${ownerId}`);
}
const HAPPIER_JOBS_SLICE_EXPECTED_PROPERTIES = [
  ['CPUWeight', '50'],
  ['IOWeight', '50'],
] as const;
const HAPPIER_CRITICAL_SLICE_EXPECTED_PROPERTIES = [
  ['MemoryLow', String(HAPPIER_CRITICAL_SLICE_MEMORY_LOW_BYTES)],
] as const;

export type SystemdUserScopedLaunchSpec = Readonly<{
  filePath: string;
  args: string[];
  env?: Record<string, string>;
}>;

export type SessionScopeExitCapture = Readonly<{ executable: string; evidencePath: string }>;

export function sessionScopeExitEvidencePath(activeServerDir: string, unit: string): string {
  if (!unit || posix.basename(unit) !== unit || !unit.endsWith('.scope')) throw new Error('Invalid Session scope');
  return join(activeServerDir, `scope-exit-${unit}.json`);
}

export function buildSessionScopeExitLaunchSpec(input: Readonly<{
  launchSpec: SystemdUserScopedLaunchSpec; unit: string; capture: SessionScopeExitCapture;
}>): SystemdUserScopedLaunchSpec {
  return { filePath: input.capture.executable,
    args: ['scope-exec', `--unit=${input.unit}`, `--evidence=${input.capture.evidencePath}`, '--',
      input.launchSpec.filePath, ...input.launchSpec.args],
    ...(input.launchSpec.env ? { env: input.launchSpec.env } : {}),
  };
}

export function shouldUseSystemdUserSessionResourceGovernor(params: Readonly<{
  platform: NodeJS.Platform;
  startupSource: string | undefined;
}>): boolean {
  // Startup source describes lifecycle ownership, not resource policy. Stack/TUI-managed
  // Linux daemons are intentionally labelled "manual" and need the same session isolation.
  return params.platform === 'linux';
}

export type SystemdUserResourceGovernorExecFile = (
  command: string,
  args: readonly string[],
  options: Readonly<{
    timeout: number;
    env: NodeJS.ProcessEnv;
    maxBuffer: number;
  }>,
) => Promise<Readonly<{ stdout: string | Buffer; stderr: string | Buffer }>>;

export async function setGuardSessionMemoryHigh(params: Readonly<{
  unit: string; bytes: number | null; environment?: NodeJS.ProcessEnv;
  execFile?: SystemdUserResourceGovernorExecFile;
}>): Promise<void> {
  await (params.execFile ?? execFileWithDeadline)('systemctl', [
    '--user', 'set-property', '--runtime', params.unit, `MemoryHigh=${params.bytes ?? 'infinity'}`,
  ], { timeout: SYSTEMD_USER_RESOURCE_GOVERNOR_PROBE_TIMEOUT_MS, env: params.environment ?? process.env, maxBuffer: 16 * 1024 });
}

/** Scope availability does not require a provisioned governor or memory controller. */
export async function readSystemdUserManager(params: Readonly<{
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  execFile?: SystemdUserResourceGovernorExecFile;
}> = {}): Promise<Readonly<{ controlGroup: string | undefined }> | null> {
  if ((params.platform ?? process.platform) !== 'linux') return null;
  try {
    const result = await (params.execFile ?? execFileWithDeadline)('systemctl', ['--user', 'show', '--property=ControlGroup'], {
      timeout: SYSTEMD_USER_RESOURCE_GOVERNOR_PROBE_TIMEOUT_MS,
      env: params.environment ?? process.env,
      maxBuffer: 16 * 1024,
    });
    return { controlGroup: parseSystemdProperties(String(result.stdout)).get('ControlGroup') };
  } catch {
    return null;
  }
}

export async function readGuardCeilingCapability(params: Readonly<{
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  execFile?: SystemdUserResourceGovernorExecFile;
  readFile?: (path: string, encoding: 'utf8') => Promise<string>;
}> = {}): Promise<MachineGuardStateV1['capabilities']['ceiling']> {
  if ((params.platform ?? process.platform) !== 'linux') return { status: 'unavailable', reason: 'not_linux' };
  const manager = await readSystemdUserManager(params);
  if (!manager) return { status: 'unavailable', reason: 'no_user_manager' };
  const { controlGroup } = manager;
  // A live user manager is separate from delegation of the memory controller to its subtree.
  if (controlGroup === undefined || (controlGroup !== '' && !controlGroup.startsWith('/')) || controlGroup.split('/').includes('..')) {
    return { status: 'unavailable', reason: 'no_memory_controller' };
  }
  try {
    const controllers = await (params.readFile ?? readFile)(posix.join('/sys/fs/cgroup', controlGroup, 'cgroup.controllers'), 'utf8');
    return controllers.trim().split(/\s+/).includes('memory')
      ? { status: 'available' } : { status: 'unavailable', reason: 'no_memory_controller' };
  } catch {
    return { status: 'unavailable', reason: 'no_memory_controller' };
  }
}

function hasSystemdUserBus(environment: NodeJS.ProcessEnv): boolean {
  return String(environment.DBUS_SESSION_BUS_ADDRESS ?? '').trim().length > 0;
}

function parseSystemdProperties(raw: string): ReadonlyMap<string, string> {
  const properties = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const delimiter = line.indexOf('=');
    if (delimiter <= 0) continue;
    properties.set(line.slice(0, delimiter).trim(), line.slice(delimiter + 1).trim());
  }
  return properties;
}

type SystemdUserSlicePolicy = Readonly<{
  sliceName: string;
  expectedProperties: readonly (readonly [string, string])[];
  requiredFiniteProperties?: readonly string[];
}>;

function isFinitePositiveSystemdLimit(value: string | undefined): boolean {
  if (!value || value === 'infinity') return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

async function isSystemdUserSliceReady(
  params: Readonly<{
    platform?: NodeJS.Platform;
    environment?: NodeJS.ProcessEnv;
    execFile?: SystemdUserResourceGovernorExecFile;
  }>,
  policy: SystemdUserSlicePolicy,
): Promise<boolean> {
  const platform = params.platform ?? process.platform;
  const environment = params.environment ?? process.env;
  if (platform !== 'linux' || !hasSystemdUserBus(environment)) return false;

  try {
    const execFile = params.execFile ?? execFileWithDeadline;
    const requiredFiniteProperties = policy.requiredFiniteProperties ?? [];
    const result = await execFile('systemctl', [
      '--user',
      'show',
      policy.sliceName,
      '--property=LoadState',
      ...policy.expectedProperties.map(([property]) => `--property=${property}`),
      ...requiredFiniteProperties.map((property) => `--property=${property}`),
    ], {
      timeout: SYSTEMD_USER_RESOURCE_GOVERNOR_PROBE_TIMEOUT_MS,
      env: environment,
      maxBuffer: 16 * 1024,
    });
    const properties = parseSystemdProperties(String(result.stdout));
    return properties.get('LoadState') === 'loaded'
      && policy.expectedProperties.every(([property, expected]) => properties.get(property) === expected)
      && requiredFiniteProperties.every((property) => isFinitePositiveSystemdLimit(properties.get(property)));
  } catch {
    return false;
  }
}

function buildSystemdUserScopedLaunchSpecForSlice(
  params: Readonly<{ launchSpec: SystemdUserScopedLaunchSpec; unit?: string; properties?: readonly string[]; expandEnvironment?: false }>,
  sliceName: string,
  scopeArgs: readonly string[],
): SystemdUserScopedLaunchSpec {
  return {
    filePath: 'systemd-run',
    args: [
      '--user',
      '--scope',
      '--quiet',
      ...(sliceName === HAPPIER_JOBS_SLICE_NAME ? ['--collect'] : []),
      ...(params.unit ? [`--unit=${params.unit}`] : []),
      ...(params.properties ?? []).flatMap(property => ['-p', property]),
      ...(params.expandEnvironment === false ? ['--expand-environment=no'] : []),
      `--slice=${sliceName}`,
      ...scopeArgs,
      '--',
      params.launchSpec.filePath,
      ...params.launchSpec.args,
    ],
    ...(params.launchSpec.env ? { env: params.launchSpec.env } : {}),
  };
}

/**
 * Checking the expected jobs policy keeps an arbitrary Linux host on its
 * existing launch path instead of turning a missing user manager into a
 * session-start failure.
 */
export async function isSystemdUserResourceGovernorReady(params: Readonly<{
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  execFile?: SystemdUserResourceGovernorExecFile;
}> = {}): Promise<boolean> {
  return await isSystemdUserSliceReady(params, {
    sliceName: HAPPIER_JOBS_SLICE_NAME,
    expectedProperties: HAPPIER_JOBS_SLICE_EXPECTED_PROPERTIES,
    requiredFiniteProperties: ['MemoryHigh'],
  });
}

export function buildSystemdUserScopedLaunchSpec(params: Readonly<{
  launchSpec: SystemdUserScopedLaunchSpec;
  unit?: string;
  properties?: readonly string[];
  expandEnvironment?: false;
  sessionExitCapture?: SessionScopeExitCapture;
}>): SystemdUserScopedLaunchSpec {
  // Raising an inherited nice value requires privileges that agent runners may not have.
  const niceValue = Math.max(10, getPriority());
  const launchSpec = params.sessionExitCapture && params.unit
    ? buildSessionScopeExitLaunchSpec({ launchSpec: params.launchSpec, unit: params.unit, capture: params.sessionExitCapture }) : params.launchSpec;
  return buildSystemdUserScopedLaunchSpecForSlice({ ...params, launchSpec }, HAPPIER_JOBS_SLICE_NAME, [`--nice=${niceValue}`]);
}

/** Older systemd releases already leave scope arguments literal and lack this option. */
export async function supportsSystemdRunEnvironmentExpansionOption(params: Readonly<{
  systemdRunPath: string;
  environment: NodeJS.ProcessEnv;
  execFile?: SystemdUserResourceGovernorExecFile;
}>): Promise<boolean | null> {
  try {
    const result = await (params.execFile ?? execFileWithDeadline)(params.systemdRunPath, ['--help'], {
      timeout: SYSTEMD_USER_RESOURCE_GOVERNOR_PROBE_TIMEOUT_MS,
      env: params.environment,
      maxBuffer: 16 * 1024,
    });
    return String(result.stdout).includes('--expand-environment=');
  } catch { return null; }
}

export async function isSystemdUserCriticalResourceGovernorReady(params: Readonly<{
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  execFile?: SystemdUserResourceGovernorExecFile;
}> = {}): Promise<boolean> {
  return await isSystemdUserSliceReady(params, {
    sliceName: HAPPIER_CRITICAL_SLICE_NAME,
    expectedProperties: HAPPIER_CRITICAL_SLICE_EXPECTED_PROPERTIES,
  });
}

export function buildSystemdUserCriticalScopedLaunchSpec(params: Readonly<{
  launchSpec: SystemdUserScopedLaunchSpec;
}>): SystemdUserScopedLaunchSpec {
  return buildSystemdUserScopedLaunchSpecForSlice(params, HAPPIER_CRITICAL_SLICE_NAME, []);
}
