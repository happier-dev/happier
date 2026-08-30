import { execFile } from 'node:child_process';

export const HAPPIER_JOBS_SLICE_NAME = 'happier-jobs.slice';
export const HAPPIER_CRITICAL_SLICE_NAME = 'happier-critical.slice';
export const HAPPIER_CRITICAL_SLICE_MEMORY_LOW_BYTES = 4 * 1024 * 1024 * 1024;

const HAPPIER_JOBS_SLICE_CPU_WEIGHT = '50';
const HAPPIER_JOBS_SLICE_IO_WEIGHT = '50';
const SYSTEMD_USER_RESOURCE_GOVERNOR_PROBE_TIMEOUT_MS = 1_000;
const HAPPIER_JOBS_SLICE_EXPECTED_PROPERTIES: readonly (readonly [string, string])[] = [
  ['CPUWeight', HAPPIER_JOBS_SLICE_CPU_WEIGHT],
  ['IOWeight', HAPPIER_JOBS_SLICE_IO_WEIGHT],
];
const HAPPIER_CRITICAL_SLICE_EXPECTED_PROPERTIES: readonly (readonly [string, string])[] = [
  ['MemoryLow', String(HAPPIER_CRITICAL_SLICE_MEMORY_LOW_BYTES)],
];

export type SystemdUserScopedLaunchSpec = Readonly<{
  filePath: string;
  args: string[];
  env?: Record<string, string>;
}>;

export type SystemdUserResourceGovernorExecFile = (
  command: string,
  args: readonly string[],
  options: Readonly<{
    timeout: number;
    env: NodeJS.ProcessEnv;
    maxBuffer: number;
  }>,
) => Promise<Readonly<{ stdout: string | Buffer; stderr: string | Buffer }>>;

const defaultExecFile: SystemdUserResourceGovernorExecFile = (command, args, options) => new Promise((resolve, reject) => {
  execFile(command, [...args], {
    timeout: options.timeout,
    env: options.env,
    maxBuffer: options.maxBuffer,
  }, (error, stdout, stderr) => {
    if (error) {
      reject(error);
      return;
    }
    resolve({ stdout, stderr });
  });
});

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
}>;

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
  if (platform !== 'linux' || !hasSystemdUserBus(environment)) {
    return false;
  }

  try {
    const runExecFile = params.execFile ?? defaultExecFile;
    const result = await runExecFile('systemctl', [
      '--user',
      'show',
      policy.sliceName,
      '--property=LoadState',
      ...policy.expectedProperties.map(([property]) => `--property=${property}`),
    ], {
      timeout: SYSTEMD_USER_RESOURCE_GOVERNOR_PROBE_TIMEOUT_MS,
      env: environment,
      maxBuffer: 16 * 1024,
    });
    const properties = parseSystemdProperties(String(result.stdout));
    return properties.get('LoadState') === 'loaded'
      && policy.expectedProperties.every(([property, expectedValue]) => (
        properties.get(property) === expectedValue
      ));
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
  });
}

export function buildSystemdUserScopedLaunchSpec(params: Readonly<{
  launchSpec: SystemdUserScopedLaunchSpec;
}>): SystemdUserScopedLaunchSpec {
  return buildSystemdUserScopedLaunchSpecForSlice(params, HAPPIER_JOBS_SLICE_NAME, ['--nice=10']);
}

/**
 * A managed guest must have this exact reservation before a detached daemon
 * joins the critical slice; otherwise the existing direct launch remains the
 * safe fallback.
 */
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
