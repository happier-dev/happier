import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getStackRootFromMeta, runNodeCapture } from './testkit/auth_testkit.mjs';

test('hstack mobile --profiling-runtime lets the simulator runtime select a booted simulator when a physical device is connected', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const mobileScript = join(rootDir, 'scripts', 'mobile.mjs');
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-mobile-profile-simulator-'));
  const repoDir = join(tmp, 'repo');
  const storageDir = join(tmp, 'storage');

  try {
    const binDir = join(tmp, 'bin');
    await mkdir(binDir, { recursive: true });

    const xcrunStub = join(binDir, 'xcrun');
    await writeFile(
      xcrunStub,
      `#!/bin/bash
set -euo pipefail
if [[ "\${1:-}" == "xcdevice" && "\${2:-}" == "list" ]]; then
  cat <<'JSON'
[
  {
    "identifier": "IOS-USB-1",
    "name": "Connected iPhone",
    "platform": "com.apple.platform.iphoneos",
    "interface": "usb",
    "available": true,
    "simulator": false
  }
]
JSON
  exit 0
fi
if [[ "\${1:-}" == "simctl" && "\${2:-}" == "list" && "\${3:-}" == "devices" ]]; then
  cat <<'JSON'
{"devices":{"iOS 26.4":[{"udid":"SIM-1","name":"Booted Perf Simulator","state":"Booted","isAvailable":true}]}}
JSON
  exit 0
fi
if [[ "\${1:-}" == "simctl" && "\${2:-}" == "install" ]]; then
  echo "SIMCTL_INSTALL_DEVICE=$3"
  exit 0
fi
if [[ "\${1:-}" == "simctl" && "\${2:-}" == "launch" ]]; then
  echo "SIMCTL_LAUNCH_DEVICE=$4"
  echo "$5: 12345"
  exit 0
fi
echo "xcrun stub: unsupported args: $*" >&2
exit 1
`,
      'utf-8'
    );

    const xcodebuildStub = join(binDir, 'xcodebuild');
    await writeFile(
      xcodebuildStub,
      `#!/bin/bash
set -euo pipefail
if [[ " $* " == *" -showBuildSettings "* ]]; then
  cat <<'SETTINGS'
    ENABLE_DEBUG_DYLIB = NO
    TARGET_BUILD_DIR = /tmp/HappierProfileBuild
    FULL_PRODUCT_NAME = Happier-Local.app
    PRODUCT_BUNDLE_IDENTIFIER = dev.happier.stack.profile
SETTINGS
  exit 0
fi
echo "XCODEBUILD_ARGS=$*"
exit 0
`,
      'utf-8'
    );

    const yarnStub = join(binDir, 'yarn');
    await writeFile(yarnStub, '#!/bin/bash\nexit 0\n', 'utf-8');

    if (process.platform !== 'win32') {
      await chmod(xcrunStub, 0o755);
      await chmod(xcodebuildStub, 0o755);
      await chmod(yarnStub, 0o755);
    }

    await mkdir(join(repoDir, 'apps', 'ui', 'node_modules'), { recursive: true });
    await writeFile(join(repoDir, 'apps', 'ui', 'app.config.js'), 'export default {};\n', 'utf-8');
    await writeFile(join(repoDir, 'apps', 'ui', 'package.json'), '{"name":"fixture-ui"}\n', 'utf-8');
    await mkdir(join(storageDir, 'main'), { recursive: true });

    const env = {
      ...process.env,
      PATH: `${binDir}:/usr/bin:/bin`,
      HAPPIER_STACK_REPO_DIR: repoDir,
      HAPPIER_STACK_HOME_DIR: join(tmp, 'home'),
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_STACK: 'main',
      HAPPIER_STACK_ENV_FILE: join(tmp, 'nonexistent-env'),
      HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
      HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL: '0',
      HAPPIER_STACK_TAILSCALE_SERVE: '0',
    };

    const res = await runNodeCapture([mobileScript, '--run-ios', '--profiling-runtime', '--no-metro'], { cwd: rootDir, env });
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    assert.match(res.stdout, /SIMCTL_INSTALL_DEVICE=SIM-1/, `expected install to target booted simulator\nstdout:\n${res.stdout}`);
    assert.match(res.stdout, /SIMCTL_LAUNCH_DEVICE=SIM-1/, `expected launch to target booted simulator\nstdout:\n${res.stdout}`);
    assert.doesNotMatch(res.stdout, /using connected device/, `profiling runtime should not auto-pick physical devices\nstdout:\n${res.stdout}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
