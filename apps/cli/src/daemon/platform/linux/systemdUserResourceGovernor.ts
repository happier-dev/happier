import { execFileWithDeadline } from '@happier-dev/cli-common/process';
import {
  HAPPIER_CRITICAL_SLICE_MEMORY_LOW_BYTES,
  HAPPIER_CRITICAL_SLICE_NAME,
} from '@happier-dev/cli-common/service';

const SYSTEMD_USER_RESOURCE_GOVERNOR_PROBE_TIMEOUT_MS = 1_000;

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

/**
 * A managed guest provisions the critical slice before this is used. Checking
 * its loaded MemoryLow reservation keeps an arbitrary Linux host on its
 * existing launch path instead of turning a missing user manager into a
 * session-start failure.
 */
export async function isSystemdUserResourceGovernorReady(params: Readonly<{
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  execFile?: SystemdUserResourceGovernorExecFile;
}> = {}): Promise<boolean> {
  const platform = params.platform ?? process.platform;
  const environment = params.environment ?? process.env;
  if (platform !== 'linux' || !hasSystemdUserBus(environment)) {
    return false;
  }

  try {
    const execFile = params.execFile ?? execFileWithDeadline;
    const result = await execFile('systemctl', [
      '--user',
      'show',
      HAPPIER_CRITICAL_SLICE_NAME,
      '--property=LoadState',
      '--property=MemoryLow',
    ], {
      timeout: SYSTEMD_USER_RESOURCE_GOVERNOR_PROBE_TIMEOUT_MS,
      env: environment,
      maxBuffer: 16 * 1024,
    });
    const properties = parseSystemdProperties(String(result.stdout));
    return properties.get('LoadState') === 'loaded'
      && properties.get('MemoryLow') === String(HAPPIER_CRITICAL_SLICE_MEMORY_LOW_BYTES);
  } catch {
    return false;
  }
}

export function buildSystemdUserScopedLaunchSpec(params: Readonly<{
  launchSpec: SystemdUserScopedLaunchSpec;
}>): SystemdUserScopedLaunchSpec {
  return {
    filePath: 'systemd-run',
    args: [
      '--user',
      '--scope',
      '--quiet',
      `--slice=${HAPPIER_CRITICAL_SLICE_NAME}`,
      '--',
      params.launchSpec.filePath,
      ...params.launchSpec.args,
    ],
    ...(params.launchSpec.env ? { env: params.launchSpec.env } : {}),
  };
}
