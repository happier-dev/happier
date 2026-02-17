import { join } from 'node:path';

import { parseArgs } from '../cli/args.mjs';
import { defaultDevClientIdentity } from './identifiers.mjs';

function normalizePortArg(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return '';
  return String(Math.floor(n));
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

  const device = (kv.get('--device') ?? '').toString();
  const clean = flags.has('--clean');
  const configuration = (kv.get('--configuration') ?? 'Debug').toString() || 'Debug';
  const port = normalizePortArg(kv.get('--port'));

  const user = (baseEnv.USER ?? baseEnv.USERNAME ?? 'user').toString();
  const identity = defaultDevClientIdentity({ user });

  const mobileScript = join(r, 'scripts', 'mobile.mjs');

  const nodeArgs = [
    mobileScript,
    '--app-env=development',
    `--ios-app-name=${identity.iosAppName}`,
    `--ios-bundle-id=${identity.iosBundleId}`,
    `--scheme=${identity.scheme}`,
    ...(port ? [`--port=${port}`] : []),
    '--prebuild',
    ...(clean ? ['--clean'] : []),
    '--run-ios',
    `--configuration=${configuration}`,
    '--no-metro',
    ...(device ? [`--device=${device}`] : []),
  ];

  const env = {
    ...baseEnv,
    EXPO_APP_SCHEME: identity.scheme,
    EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: baseEnv.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE ?? '',
  };

  return {
    nodeArgs,
    env,
    identity,
    device,
    clean,
    configuration,
    port,
  };
}

