import { parseArgs } from '../utils/cli/args.mjs';
import { printResult, wantsJson } from '../utils/cli/cli.mjs';
import { parseEnvToObject } from '../utils/env/dotenv.mjs';
import { ensureEnvFileUpdated } from '../utils/env/env_file.mjs';
import { readTextOrEmpty } from '../utils/fs/ops.mjs';
import { resolveStackEnvPath } from '../utils/paths/paths.mjs';
import { defaultDevClientIdentity, defaultStackReleaseIdentity } from '../utils/mobile/identifiers.mjs';

import { runStackScriptWithStackEnv } from './run_script_with_stack_env.mjs';

function resolveRequestedAppEnv(mobileKv) {
  const raw = (mobileKv.get('--app-env') ?? '').toString().trim().toLowerCase();
  return raw === 'development' ? 'development' : 'production';
}

function resolveInstallConfiguration({ appEnv, mobileKv }) {
  const explicit = (mobileKv.get('--configuration') ?? '').toString().trim();
  if (explicit) return explicit;
  return appEnv === 'development' ? 'Debug' : 'Release';
}

function buildDevelopmentInstallExtraEnv() {
  return {
    HAPPIER_EXPO_DEVCLIENT_LAUNCH_MODE: 'most-recent',
    HAPPIER_EXPO_DEVCLIENT_SILENT_LAUNCH: 'true',
    HAPPIER_EXPO_USE_NATIVE_DEBUG: 'true',
    EX_UPDATES_NATIVE_DEBUG: '1',
  };
}

export function resolveStackMobileInstallPlan({ stackName, passthrough, existing, user }) {
  const { kv: mobileKv } = parseArgs(passthrough);
  const device = (mobileKv.get('--device') ?? '').toString();
  const name = (mobileKv.get('--name') ?? mobileKv.get('--app-name') ?? '').toString().trim();
  const appEnv = resolveRequestedAppEnv(mobileKv);
  const configuration = resolveInstallConfiguration({ appEnv, mobileKv });

  const priorNameKey =
    appEnv === 'development'
      ? 'HAPPIER_STACK_MOBILE_DEVELOPMENT_IOS_APP_NAME'
      : 'HAPPIER_STACK_MOBILE_RELEASE_IOS_APP_NAME';
  const priorName = (existing?.[priorNameKey] ?? '').toString().trim();
  const identity =
    appEnv === 'development'
      ? {
          ...defaultDevClientIdentity({ user }),
          ...(name || priorName ? { iosAppName: name || priorName } : {}),
        }
      : defaultStackReleaseIdentity({
          stackName,
          user,
          appName: name || priorName || null,
        });

  const envUpdates =
    appEnv === 'development'
      ? [
          { key: 'HAPPIER_STACK_MOBILE_DEVELOPMENT_IOS_APP_NAME', value: identity.iosAppName },
          { key: 'HAPPIER_STACK_MOBILE_DEVELOPMENT_IOS_BUNDLE_ID', value: identity.iosBundleId },
          { key: 'HAPPIER_STACK_MOBILE_DEVELOPMENT_SCHEME', value: identity.scheme },
        ]
      : [
          { key: 'HAPPIER_STACK_MOBILE_RELEASE_IOS_APP_NAME', value: identity.iosAppName },
          { key: 'HAPPIER_STACK_MOBILE_RELEASE_IOS_BUNDLE_ID', value: identity.iosBundleId },
          { key: 'HAPPIER_STACK_MOBILE_RELEASE_SCHEME', value: identity.scheme },
        ];

  const args = [
    `--app-env=${appEnv}`,
    `--ios-app-name=${identity.iosAppName}`,
    `--ios-bundle-id=${identity.iosBundleId}`,
    `--scheme=${identity.scheme}`,
    '--prebuild',
    '--run-ios',
    `--configuration=${configuration}`,
    '--no-metro',
    ...(device ? [`--device=${device}`] : []),
  ];

  return {
    appEnv,
    identity,
    envUpdates,
    args,
    extraEnv: appEnv === 'development' ? buildDevelopmentInstallExtraEnv() : {},
  };
}

export async function runStackMobileInstallCommand({ rootDir, stackName, passthrough, json }) {
  const { flags: mobileFlags, kv: mobileKv } = parseArgs(passthrough);
  const jsonOut = wantsJson(passthrough, { flags: mobileFlags }) || json;

  const envPath = resolveStackEnvPath(stackName).envPath;
  const existingRaw = await readTextOrEmpty(envPath);
  const existing = parseEnvToObject(existingRaw);
  const plan = resolveStackMobileInstallPlan({
    stackName,
    passthrough,
    existing,
    user: process.env.USER ?? process.env.USERNAME ?? 'user',
  });

  await ensureEnvFileUpdated({
    envPath,
    updates: plan.envUpdates,
  });

  await runStackScriptWithStackEnv({
    rootDir,
    stackName,
    scriptPath: 'mobile.mjs',
    args: plan.args,
    extraEnv: plan.extraEnv,
  });

  if (jsonOut) {
    printResult({
      json: true,
      data: {
        ok: true,
        stackName,
        installed: true,
        appEnv: plan.appEnv,
        identity: plan.identity,
      },
    });
  }
}
