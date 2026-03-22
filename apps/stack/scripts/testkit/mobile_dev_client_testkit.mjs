import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildStackHarnessEnv, writeFakeBin } from './core/fake_bin_harness.mjs';
import { createTempFixture } from './core/temp_fixture.mjs';
import { getStackRootFromMeta, runNodeCapture } from './auth_testkit.mjs';

function toExecutableScript(body) {
  return body.endsWith('\n') ? body : `${body}\n`;
}

export async function createMobileDevClientTestFixture(
  t,
  {
    importMetaUrl,
    prefix = 'hstack-mobile-dev-client-',
    includeRepoDir = false,
    includeHomeDir = false,
    includeStorageDir = false,
    stackName = 'main',
  } = {},
) {
  const fixture = await createTempFixture(t, { prefix });
  const rootDir = getStackRootFromMeta(importMetaUrl);
  const devClientScript = join(rootDir, 'scripts', 'mobile_dev_client.mjs');
  const repoDir = includeRepoDir ? fixture.path('repo') : null;
  const homeDir = includeHomeDir ? fixture.path('home') : null;
  const storageDir = includeStorageDir ? fixture.path('storage') : null;

  if (storageDir) {
    await mkdir(join(storageDir, stackName), { recursive: true });
  }

  async function writeBin(name, content) {
    return writeFakeBin({
      root: fixture.root,
      name,
      content: toExecutableScript(content),
    });
  }

  return {
    ...fixture,
    rootDir,
    devClientScript,
    repoDir,
    homeDir,
    storageDir,
    stackName,
    writeBin,
    writeNoopBin(name) {
      return writeBin(name, '#!/bin/bash\nexit 0\n');
    },
    writeAdbDevicesBin({ serial = 'ABC123', hasDevice = true } = {}) {
      const deviceLine = hasDevice ? `  printf "${serial}\\tdevice\\n"\n` : '';
      return writeBin(
        'adb',
        `#!/bin/bash
set -euo pipefail
if [[ "\${1:-}" == "devices" ]]; then
  echo "List of devices attached"
${deviceLine}  echo ""
  exit 0
fi
exit 0
`,
      );
    },
    writeXcrunListBin(jsonText = '[]') {
      return writeBin(
        'xcrun',
        `#!/bin/bash
set -euo pipefail
if [[ "\${1:-}" == "xcdevice" && "\${2:-}" == "list" ]]; then
  cat <<'JSON'
${jsonText}
JSON
  exit 0
fi
exit 0
`,
      );
    },
    async writeExpoStub(script = `#!${process.execPath}\nprocess.exit(0);\n`) {
      if (!repoDir) {
        throw new Error('writeExpoStub requires includeRepoDir=true');
      }
      const expoBin = join(repoDir, 'apps', 'ui', 'node_modules', '.bin', 'expo');
      await mkdir(join(repoDir, 'apps', 'ui', 'node_modules', '.bin'), { recursive: true });
      await writeFile(expoBin, script, 'utf-8');
      writeFakeBin({
        root: join(repoDir, 'apps', 'ui', 'node_modules'),
        binDirName: '.bin',
        name: 'expo',
        content: script,
      });
      return expoBin;
    },
    buildEnv({
      androidHome = false,
      expoToken,
      extraEnv = {},
    } = {}) {
      return buildStackHarnessEnv({
        extraEnv: {
          HSTACK_MOBILE_DEV_CLIENT_TEST_STUB: '1',
          HAPPIER_STACK_ENV_FILE: fixture.path('nonexistent-env'),
          ...(androidHome ? { ANDROID_HOME: fixture.path('android-home') } : {}),
          ...(expoToken ? { EXPO_TOKEN: expoToken } : {}),
          ...(repoDir ? { HAPPIER_STACK_REPO_DIR: repoDir } : {}),
          ...(homeDir ? { HAPPIER_STACK_HOME_DIR: homeDir } : {}),
          ...(storageDir
            ? {
                HAPPIER_STACK_STORAGE_DIR: storageDir,
                HAPPIER_STACK_STACK: stackName,
                HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL: '0',
                HAPPIER_STACK_TAILSCALE_SERVE: '0',
              }
            : {}),
          ...extraEnv,
        },
        binDirs: [fixture.path('bin')],
      });
    },
    run(args, { env } = {}) {
      return runNodeCapture([devClientScript, ...args], { cwd: rootDir, env });
    },
  };
}
