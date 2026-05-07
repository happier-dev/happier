import { join } from 'node:path';

import { parseArgs } from '../cli/args.mjs';
import { getFlagValue } from '../cli/arg_values.mjs';
import { defaultDevClientIdentity } from './identifiers.mjs';

function normalizePortArg(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return '';
  return String(Math.floor(n));
}

function splitJvmFlags(raw) {
  return String(raw ?? '')
    .trim()
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function upsertJvmFlag(parts, flag, predicate) {
  const next = parts.filter((part) => !predicate(part));
  next.push(flag);
  return next;
}

function resolveAndroidDevClientGradleOpts(raw) {
  let parts = splitJvmFlags(raw);
  parts = upsertJvmFlag(parts, '-Dorg.gradle.daemon=false', (part) => part.startsWith('-Dorg.gradle.daemon='));
  parts = upsertJvmFlag(parts, '-Dorg.gradle.parallel=false', (part) => part.startsWith('-Dorg.gradle.parallel='));
  parts = upsertJvmFlag(parts, '-Dorg.gradle.workers.max=1', (part) => part.startsWith('-Dorg.gradle.workers.max='));
  return parts.join(' ');
}

export function buildMobileDevClientInstallInvocation({
  rootDir,
  argv,
  baseEnv = process.env,
} = {}) {
  const r = String(rootDir ?? '').trim();
  if (!r) {
    throw new Error('[mobile-dev-client] missing rootDir');
  }

  const a = Array.isArray(argv) ? argv : [];
  const { flags, kv } = parseArgs(a);

  const platformRaw = String(getFlagValue({ argv: a, kv, flag: '--platform' }) ?? '')
    .trim()
    .toLowerCase();
  const platform = platformRaw === 'android' ? 'android' : 'ios';

  const device = String(getFlagValue({ argv: a, kv, flag: '--device' }) ?? '');
  const clean = flags.has('--clean');
  const configuration =
    (getFlagValue({ argv: a, kv, flag: '--configuration' }) ?? kv.get('--configuration') ?? 'Debug').toString() ||
    'Debug';
  const port = normalizePortArg(getFlagValue({ argv: a, kv, flag: '--port' }));

  const user = (baseEnv.USER ?? baseEnv.USERNAME ?? 'user').toString();
  const profile = String(
    getFlagValue({ argv: a, kv, flag: '--profile' }) ??
      baseEnv.HAPPIER_STACK_DEV_CLIENT_PROFILE ??
      baseEnv.HAPPIER_MOBILE_DEV_CLIENT_PROFILE ??
      ''
  ).trim();
  const identityBase = defaultDevClientIdentity({ user, profile });

  const schemeOverride = String(getFlagValue({ argv: a, kv, flag: '--scheme' }) ?? '').trim();
  const bundleIdOverride = String(getFlagValue({ argv: a, kv, flag: '--bundle-id' }) ?? '').trim();
  const androidPackageOverride = String(getFlagValue({ argv: a, kv, flag: '--android-package' }) ?? '').trim();
  const appNameOverride = String(getFlagValue({ argv: a, kv, flag: '--app-name' }) ?? '').trim();

  const identity = {
    ...identityBase,
    ...(schemeOverride ? { scheme: schemeOverride } : {}),
    ...(bundleIdOverride ? { iosBundleId: bundleIdOverride } : {}),
    ...(androidPackageOverride ? { androidPackage: androidPackageOverride } : {}),
    ...(appNameOverride ? { iosAppName: appNameOverride } : {}),
  };

  const mobileScript = join(r, 'scripts', 'mobile.mjs');

  const nodeArgs = [
    mobileScript,
    `--app-env=${identity.appEnv}`,
    `--ios-app-name=${identity.iosAppName}`,
    `--ios-bundle-id=${identity.iosBundleId}`,
    `--scheme=${identity.scheme}`,
    ...(port ? [`--port=${port}`] : []),
    '--prebuild',
    ...(platform === 'android' ? ['--platform=android'] : []),
    ...(clean ? ['--clean'] : []),
    ...(platform === 'android' ? ['--run-android'] : ['--run-ios', `--configuration=${configuration}`]),
    '--no-metro',
    ...(device ? [`--device=${device}`] : []),
  ];

  const env = {
    ...baseEnv,
    EXPO_APP_SCHEME: identity.scheme,
    EXPO_APP_NAME: identity.iosAppName,
    EXPO_APP_BUNDLE_ID: identity.iosBundleId,
    EXPO_ANDROID_PACKAGE: identity.androidPackage,
    EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: baseEnv.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE ?? '',
  };
  if (platform === 'android') {
    env.GRADLE_OPTS = resolveAndroidDevClientGradleOpts(baseEnv.GRADLE_OPTS);
    env.HAPPIER_STACK_CLEAR_ANDROID_NATIVE_BUILD_STATE = '1';
  }
  // Keep Expo slug stable so EAS local builds don't fail when `extra.eas.projectId` is configured.
  // Dev/prod isolation should be done via EXPO_APP_SCHEME (and bundle id), not slug.
  // Explicitly blank EXPO_APP_SLUG so higher-precedence pipeline env sources (env-files/Keychain bundles)
  // cannot accidentally override it back to a non-matching slug.
  env.EXPO_APP_SLUG = '';

  return {
    nodeArgs,
    env,
    identity,
    profile: identity.profile,
    easBuildProfile: identity.easBuildProfile,
    platform,
    device,
    clean,
    configuration,
    port,
  };
}
