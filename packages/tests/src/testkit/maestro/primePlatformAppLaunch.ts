import { spawnSync } from 'node:child_process';

import { sleep } from '../timing';

export type PrimePlatformAppLaunchParams = Readonly<{
  env: NodeJS.ProcessEnv;
  platform: 'android' | 'ios';
  appId: string;
}>;

const DEFAULT_ANDROID_PRIME_APP_LAUNCH_ATTEMPTS = 3;
const DEFAULT_ANDROID_PRIME_APP_LAUNCH_RETRY_DELAY_MS = 500;
const DEFAULT_ANDROID_PRIME_APP_LAUNCH_TIMEOUT_MS = 15_000;
const MAX_ADB_DIAGNOSTIC_CHARS = 1_000;

function adbCommand(env: NodeJS.ProcessEnv): string {
  return (String(env.HAPPIER_E2E_ADB_BIN ?? '').trim() || 'adb');
}

function readPositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function summarizeAdbOutput(params: Readonly<{
  status: number | null;
  stdout: unknown;
  stderr: unknown;
}>): string {
  const parts = [`status=${params.status ?? 'null'}`];
  const stdout = String(params.stdout ?? '').trim();
  const stderr = String(params.stderr ?? '').trim();
  if (stdout) parts.push(`stdout=${JSON.stringify(stdout.slice(0, MAX_ADB_DIAGNOSTIC_CHARS))}`);
  if (stderr) parts.push(`stderr=${JSON.stringify(stderr.slice(0, MAX_ADB_DIAGNOSTIC_CHARS))}`);
  return parts.join(' ');
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

  const timeoutMs = readPositiveInteger(
    params.env.HAPPIER_E2E_ANDROID_PRIME_APP_LAUNCH_TIMEOUT_MS,
    DEFAULT_ANDROID_PRIME_APP_LAUNCH_TIMEOUT_MS,
  );
  const attempts = readPositiveInteger(
    params.env.HAPPIER_E2E_ANDROID_PRIME_APP_LAUNCH_ATTEMPTS,
    DEFAULT_ANDROID_PRIME_APP_LAUNCH_ATTEMPTS,
  );
  const retryDelayMs = readPositiveInteger(
    params.env.HAPPIER_E2E_ANDROID_PRIME_APP_LAUNCH_RETRY_DELAY_MS,
    DEFAULT_ANDROID_PRIME_APP_LAUNCH_RETRY_DELAY_MS,
  );
  const baseArgs = resolveAndroidBaseArgs(params.env);

  let component: string | null = null;
  let lastResolveDiagnostic = '';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const resolvedActivity = spawnSync(
      adbCommand(params.env),
      [...baseArgs, 'shell', 'cmd', 'package', 'resolve-activity', '--brief', params.appId],
      { encoding: 'utf8', timeout: timeoutMs, env: params.env },
    );
    lastResolveDiagnostic = summarizeAdbOutput(resolvedActivity);
    if (resolvedActivity.status === 0) {
      component = parseResolvedAndroidLaunchableActivity(String(resolvedActivity.stdout ?? ''), params.appId);
      if (component) break;
    }
    if (attempt < attempts) await sleep(retryDelayMs);
  }

  if (!component) {
    throw new Error(
      `Android launcher activity for ${params.appId} could not be resolved after ${attempts} attempts. Last adb response: ${lastResolveDiagnostic}`,
    );
  }

  let lastLaunchDiagnostic = '';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const launch = spawnSync(
      adbCommand(params.env),
      [...baseArgs, 'shell', 'am', 'start', '-W', '-n', component],
      { encoding: 'utf8', timeout: timeoutMs, env: params.env },
    );
    lastLaunchDiagnostic = summarizeAdbOutput(launch);
    if (launch.status === 0) return;
    if (attempt < attempts) await sleep(retryDelayMs);
  }

  throw new Error(
    `Failed to prelaunch Android app ${params.appId} after ${attempts} attempts. Last adb response: ${lastLaunchDiagnostic}`,
  );
}
