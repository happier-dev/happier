import { parseArgs } from '../utils/cli/args.mjs';
import { printResult, wantsJson } from '../utils/cli/cli.mjs';
import { parseEnvToObject } from '../utils/env/dotenv.mjs';
import { ensureEnvFileUpdated } from '../utils/env/env_file.mjs';
import { readTextOrEmpty } from '../utils/fs/ops.mjs';
import { resolveStackEnvPath } from '../utils/paths/paths.mjs';
import { defaultStackReleaseIdentity } from '../utils/mobile/identifiers.mjs';

import { runStackScriptWithStackEnv } from './run_script_with_stack_env.mjs';

export async function runStackMobileInstallCommand({ rootDir, stackName, passthrough, json }) {
  const { flags: mobileFlags, kv: mobileKv } = parseArgs(passthrough);
  const device = (mobileKv.get('--device') ?? '').toString();
  const name = (mobileKv.get('--name') ?? mobileKv.get('--app-name') ?? '').toString().trim();
  const jsonOut = wantsJson(passthrough, { flags: mobileFlags }) || json;

  const envPath = resolveStackEnvPath(stackName).envPath;
  const existingRaw = await readTextOrEmpty(envPath);
  const existing = parseEnvToObject(existingRaw);
  const priorName = (existing.HAPPIER_STACK_MOBILE_RELEASE_IOS_APP_NAME ?? '').toString().trim();
  const identity = defaultStackReleaseIdentity({
    stackName,
    user: process.env.USER ?? process.env.USERNAME ?? 'user',
    appName: name || priorName || null,
  });

  await ensureEnvFileUpdated({
    envPath,
    updates: [
      { key: 'HAPPIER_STACK_MOBILE_RELEASE_IOS_APP_NAME', value: identity.iosAppName },
      { key: 'HAPPIER_STACK_MOBILE_RELEASE_IOS_BUNDLE_ID', value: identity.iosBundleId },
      { key: 'HAPPIER_STACK_MOBILE_RELEASE_SCHEME', value: identity.scheme },
    ],
  });

  const args = [
    '--app-env=production',
    `--ios-app-name=${identity.iosAppName}`,
    `--ios-bundle-id=${identity.iosBundleId}`,
    `--scheme=${identity.scheme}`,
    '--prebuild',
    '--run-ios',
    '--configuration=Release',
    '--no-metro',
    ...(device ? [`--device=${device}`] : []),
  ];

  await runStackScriptWithStackEnv({ rootDir, stackName, scriptPath: 'mobile.mjs', args });

  if (jsonOut) {
    printResult({
      json: true,
      data: {
        ok: true,
        stackName,
        installed: true,
        identity,
      },
    });
  }
}
