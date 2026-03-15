import { commandExists } from '../proc/commands.mjs';

function hasAndroidSdkEnv(env) {
  const e = env && typeof env === 'object' ? env : process.env;
  const home = String(e.ANDROID_HOME ?? '').trim();
  const root = String(e.ANDROID_SDK_ROOT ?? '').trim();
  return Boolean(home || root);
}

/**
 * @typedef {'expo_run_android' | 'eas_local_dagger' | 'missing_prereqs'} AndroidDevClientStrategyKind
 */

/**
 * Decide how to install an Android dev-client when requested via `hstack mobile-dev-client --install --platform=android`.
 *
 * - Prefer `expo run:android` on the host when it looks like an Android SDK is configured.
 * - Otherwise fall back to an EAS local build inside Dagger (Linux container), which requires EXPO_TOKEN.
 *
 * @param {{ env?: Record<string, string | undefined>; cwd?: string }} [opts]
 * @returns {Promise<
 *   | { kind: 'expo_run_android' }
 *   | { kind: 'eas_local_dagger' }
 *   | { kind: 'missing_prereqs'; missing: string[] }
 * >}
 */
export async function resolveAndroidDevClientInstallStrategy(opts = {}) {
  const env = opts.env && typeof opts.env === 'object' ? opts.env : process.env;
  const cwd = typeof opts.cwd === 'string' && opts.cwd.trim() ? opts.cwd.trim() : undefined;

  const sdkEnv = hasAndroidSdkEnv(env);
  const hasAdb = await commandExists('adb', { cwd, env, timeoutMs: 5_000 });
  const hasJava = await commandExists('java', { cwd, env, timeoutMs: 5_000 });

  if (sdkEnv && hasAdb && hasJava) {
    return { kind: 'expo_run_android' };
  }

  const hasDagger = await commandExists('dagger', { cwd, env, timeoutMs: 5_000 });
  const hasDocker = await commandExists('docker', { cwd, env, timeoutMs: 5_000 });
  if (hasDagger && hasDocker) {
    return { kind: 'eas_local_dagger' };
  }

  /** @type {string[]} */
  const missing = [];
  if (!(sdkEnv && hasAdb && hasJava)) {
    missing.push('android_sdk');
  }
  if (!hasDagger) missing.push('dagger');
  if (!hasDocker) missing.push('docker');

  return { kind: 'missing_prereqs', missing };
}
