import { getPriority } from 'node:os';

import { execFileWithDeadline } from '@happier-dev/cli-common/process';
import {
  HAPPIER_CRITICAL_SLICE_MEMORY_LOW_BYTES,
  HAPPIER_CRITICAL_SLICE_NAME,
} from '@happier-dev/cli-common/service';

const SYSTEMD_USER_RESOURCE_GOVERNOR_PROBE_TIMEOUT_MS = 1_000;
const HAPPIER_JOBS_SLICE_NAME = 'happier-jobs.slice';
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
  params: Readonly<{ launchSpec: SystemdUserScopedLaunchSpec }>,
  sliceName: string,
  scopeArgs: readonly string[],
): SystemdUserScopedLaunchSpec {
  return {
    filePath: 'systemd-run',
    args: [
      '--user',
      '--scope',
      '--quiet',
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
}>): SystemdUserScopedLaunchSpec {
  // Raising an inherited nice value requires privileges that agent runners may not have.
  const niceValue = Math.max(10, getPriority());
  return buildSystemdUserScopedLaunchSpecForSlice(params, HAPPIER_JOBS_SLICE_NAME, [`--nice=${niceValue}`]);
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
