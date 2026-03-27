import { spawnSync } from 'node:child_process';

export type PrimePlatformAppLaunchParams = Readonly<{
  env: NodeJS.ProcessEnv;
  platform: 'android' | 'ios';
  appId: string;
}>;

function adbCommand(env: NodeJS.ProcessEnv): string {
  return (String(env.HAPPIER_E2E_ADB_BIN ?? '').trim() || 'adb');
}

function resolveAndroidBaseArgs(env: NodeJS.ProcessEnv): string[] {
  const serial = String(env.HAPPIER_E2E_ANDROID_SERIAL ?? env.ANDROID_SERIAL ?? '').trim();
  return serial ? ['-s', serial] : [];
}

export function parseResolvedAndroidLaunchableActivity(stdout: string, appId: string): string | null {
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line.startsWith(`${appId}/`)) return line;
  }

  return null;
}

export async function defaultPrimePlatformAppLaunch(params: PrimePlatformAppLaunchParams): Promise<void> {
  if (params.platform !== 'android') return;

  const timeoutMs =
    Number.parseInt(params.env.HAPPIER_E2E_ANDROID_PRIME_APP_LAUNCH_TIMEOUT_MS ?? '15000', 10) || 15000;
  const baseArgs = resolveAndroidBaseArgs(params.env);

  const resolvedActivity = spawnSync(
    adbCommand(params.env),
    [...baseArgs, 'shell', 'cmd', 'package', 'resolve-activity', '--brief', params.appId],
    { encoding: 'utf8', timeout: timeoutMs, env: params.env },
  );

  if (resolvedActivity.status !== 0) {
    const stderr = String(resolvedActivity.stderr ?? '').trim();
    throw new Error(`Failed to resolve Android launcher activity for ${params.appId}${stderr ? `: ${stderr}` : ''}`);
  }

  const component = parseResolvedAndroidLaunchableActivity(String(resolvedActivity.stdout ?? ''), params.appId);
  if (!component) {
    throw new Error(`Android launcher activity for ${params.appId} could not be resolved from adb output.`);
  }

  const launch = spawnSync(
    adbCommand(params.env),
    [...baseArgs, 'shell', 'am', 'start', '-W', '-n', component],
    { encoding: 'utf8', timeout: timeoutMs, env: params.env },
  );

  if (launch.status !== 0) {
    const stderr = String(launch.stderr ?? '').trim();
    throw new Error(`Failed to prelaunch Android app ${params.appId}${stderr ? `: ${stderr}` : ''}`);
  }
}
