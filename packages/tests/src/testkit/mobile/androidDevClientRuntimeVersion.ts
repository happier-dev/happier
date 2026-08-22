import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function commandFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  return String(env[key] ?? '').trim() || fallback;
}

function successfulStdout(result: ReturnType<typeof spawnSync>): string | null {
  if (result.error || result.status !== 0) return null;
  const stdout = typeof result.stdout === 'string' ? result.stdout : result.stdout?.toString('utf8') ?? '';
  return stdout.trim() ? stdout : null;
}

function runTextCommand(params: Readonly<{
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}>): string | null {
  return successfulStdout(spawnSync(params.command, params.args, {
    encoding: 'utf8',
    env: { ...process.env, ...params.env },
    maxBuffer: 4 * 1024 * 1024,
    timeout: params.timeoutMs,
  }));
}

function runStatusCommand(params: Readonly<{
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}>): boolean {
  const result = spawnSync(params.command, params.args, {
    encoding: 'utf8',
    env: { ...process.env, ...params.env },
    maxBuffer: 4 * 1024 * 1024,
    timeout: params.timeoutMs,
  });
  return !result.error && result.status === 0;
}

function parseBaseApkPath(pmPathOutput: string): string | null {
  const packagePaths = pmPathOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('package:'))
    .map((line) => line.slice('package:'.length).trim())
    .filter(Boolean);

  return packagePaths.find((line) => line.endsWith('/base.apk')) ?? packagePaths[0] ?? null;
}

function selectedAdbArgs(env: NodeJS.ProcessEnv): string[] {
  const deviceId = String(
    env.HAPPIER_E2E_MOBILE_DEVICE_ID
    ?? env.HAPPIER_E2E_ANDROID_SERIAL
    ?? env.ANDROID_SERIAL
    ?? '',
  ).trim();
  return deviceId ? ['-s', deviceId] : [];
}

export type InstalledAndroidDevClientIdentity = Readonly<{
  baseApkSha256: string;
  runtimeVersion: string | null;
}>;

export function resolveInstalledAndroidDevClientIdentity(params: Readonly<{
  appId: string;
  env: NodeJS.ProcessEnv;
  outputDir: string;
}>): InstalledAndroidDevClientIdentity | null {
  const appId = params.appId.trim();
  if (!appId) return null;

  const adb = commandFromEnv(params.env, 'HAPPIER_E2E_ADB_BIN', 'adb');
  const adbDeviceArgs = selectedAdbArgs(params.env);
  const pmPathOutput = runTextCommand({
    command: adb,
    args: [...adbDeviceArgs, 'shell', 'pm', 'path', appId],
    env: params.env,
    timeoutMs: 10_000,
  });
  if (!pmPathOutput) return null;

  const remoteApkPath = parseBaseApkPath(pmPathOutput);
  if (!remoteApkPath) return null;

  mkdirSync(params.outputDir, { recursive: true });
  const localApkPath = join(params.outputDir, 'android-dev-client-base.apk');
  const pulled = runStatusCommand({
    command: adb,
    args: [...adbDeviceArgs, 'pull', remoteApkPath, localApkPath],
    env: params.env,
    timeoutMs: 120_000,
  });
  if (!pulled) return null;

  const unzip = commandFromEnv(params.env, 'HAPPIER_E2E_UNZIP_BIN', 'unzip');
  const fingerprint = runTextCommand({
    command: unzip,
    args: ['-p', localApkPath, 'assets/fingerprint'],
    env: params.env,
    timeoutMs: 10_000,
  });
  let apkBytes: Buffer;
  try {
    apkBytes = readFileSync(localApkPath);
  } catch {
    return null;
  }
  return Object.freeze({
    baseApkSha256: `sha256:${createHash('sha256').update(apkBytes).digest('hex')}`,
    runtimeVersion: fingerprint?.trim() || null,
  });
}

export function resolveInstalledAndroidDevClientRuntimeVersion(params: Readonly<{
  appId: string;
  env: NodeJS.ProcessEnv;
  outputDir: string;
}>): string | null {
  return resolveInstalledAndroidDevClientIdentity(params)?.runtimeVersion ?? null;
}
