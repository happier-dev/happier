import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { getStackRootFromMeta, runNodeCapture } from './testkit/auth_testkit.mjs';

test('hstack mobile-dev-client autopicks ios when an iPhone is connected over USB', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const devClientScript = join(rootDir, 'scripts', 'mobile_dev_client.mjs');

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-mobile-dev-client-autopick-ios-'));
  try {
    const binDir = join(tmp, 'bin');
    await mkdir(binDir, { recursive: true });

    const adbStub = join(binDir, 'adb');
    const xcrunStub = join(binDir, 'xcrun');
    await writeFile(
      adbStub,
      `#!/bin/bash
set -euo pipefail
if [[ "\${1:-}" == "devices" ]]; then
  echo "List of devices attached"
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
  cat <<'JSON'
[
  {
    "identifier": "IOS-USB-1",
    "name": "Leeroy’s iPhone",
    "platform": "com.apple.platform.iphoneos",
    "interface": "usb",
    "available": true,
    "simulator": false
  }
]
JSON
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
      PATH: `${binDir}:${dirname(process.execPath)}:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin`,
      HSTACK_MOBILE_DEV_CLIENT_TEST_STUB: '1',
      HAPPIER_STACK_ENV_FILE: join(tmp, 'nonexistent-env'),
    };

    const res = await runNodeCapture([devClientScript, '--install'], { cwd: rootDir, env });
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);

    const parsed = JSON.parse(res.stdout.trim() || '{}');
    assert.equal(parsed.platform, 'ios');
    assert.equal(parsed.strategy, 'ios');
    const step0Args = Array.isArray(parsed.steps?.[0]?.args) ? parsed.steps[0].args.join(' ') : '';
    assert.ok(step0Args.includes('--run-ios'), `expected plan to include --run-ios\nstdout:\n${res.stdout}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
