import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getStackRootFromMeta, runNodeCapture } from './testkit/auth_testkit.mjs';

test('hstack mobile-dev-client --platform=android --reuse installs existing APK without rebuilding (test stub)', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const devClientScript = join(rootDir, 'scripts', 'mobile_dev_client.mjs');

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-mobile-dev-client-reuse-apk-'));
  try {
    const repoDir = join(tmp, 'repo');
    const storageDir = join(tmp, 'storage');
    const binDir = join(tmp, 'bin');

    await mkdir(binDir, { recursive: true });
    await mkdir(join(storageDir, 'main'), { recursive: true });

    const apkRel = join('dist', 'ui-mobile', 'happier-dev-client-android.apk');
    const apkAbs = join(repoDir, apkRel);
    await mkdir(join(repoDir, 'dist', 'ui-mobile'), { recursive: true });
    await writeFile(apkAbs, 'apk-bytes', 'utf-8');

    const adbStub = join(binDir, 'adb');
    const xcrunStub = join(binDir, 'xcrun');
    await writeFile(
      adbStub,
      `#!/bin/bash
set -euo pipefail
if [[ "\${1:-}" == "devices" ]]; then
  echo "List of devices attached"
  printf "ABC123\\tdevice\\n"
  echo ""
  exit 0
fi
exit 0
`,
      'utf-8'
    );
    await writeFile(
      xcrunStub,
      `#!/bin/bash
set -euo pipefail
if [[ "\${1:-}" == "xcdevice" && "\${2:-}" == "list" ]]; then
  echo "[]"
  exit 0
fi
exit 0
`,
      'utf-8'
    );

    if (process.platform !== 'win32') {
      await chmod(adbStub, 0o755);
      await chmod(xcrunStub, 0o755);
    }

    const env = {
      ...process.env,
      PATH: `${binDir}:/usr/bin:/bin`,
      HSTACK_MOBILE_DEV_CLIENT_TEST_STUB: '1',
      HAPPIER_STACK_REPO_DIR: repoDir,
      HAPPIER_STACK_HOME_DIR: join(tmp, 'home'),
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_STACK: 'main',
      HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL: '0',
      HAPPIER_STACK_TAILSCALE_SERVE: '0',
      HAPPIER_STACK_ENV_FILE: join(tmp, 'nonexistent-env'),
    };

    const res = await runNodeCapture([devClientScript, '--install', '--platform=android', '--reuse'], { cwd: rootDir, env });
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);

    const parsed = JSON.parse(res.stdout.trim() || '{}');
    assert.equal(parsed.platform, 'android');
    assert.equal(parsed.strategy, 'reuse_apk');

    const step0 = parsed.steps?.[0];
    assert.equal(step0?.cmd, 'adb');
    assert.deepEqual(step0?.args?.slice(0, 3), ['install', '-r', apkAbs]);
    const step0ArgsText = Array.isArray(step0?.args) ? step0.args.join(' ') : '';
    assert.ok(step0ArgsText.includes('ABC123') || step0ArgsText.includes('install'), 'expected adb install step to exist');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
