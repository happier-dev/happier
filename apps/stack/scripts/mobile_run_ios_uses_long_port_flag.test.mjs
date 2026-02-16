import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getStackRootFromMeta, runNodeCapture } from './testkit/auth_testkit.mjs';

function parseKeyValueLines(text) {
  const out = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

test('hstack mobile --run-ios passes --port (long flag) so Expo uses the requested Metro port', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const mobileScript = join(rootDir, 'scripts', 'mobile.mjs');

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-mobile-runios-longport-'));
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
  echo "[]"
  exit 0
fi
echo "xcrun stub: unsupported args: $*" >&2
exit 1
`,
      'utf-8'
    );
    if (process.platform !== 'win32') {
      await chmod(xcrunStub, 0o755);
    }

    const uiDir = join(repoDir, 'apps', 'ui');
    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });

    await writeFile(
      expoBin,
      `#!${process.execPath}
console.log('ARGS=' + JSON.stringify(process.argv.slice(2)));
console.log('RCT_METRO_PORT=' + (process.env.RCT_METRO_PORT ?? ''));
console.log('EXPO_PACKAGER_PORT=' + (process.env.EXPO_PACKAGER_PORT ?? ''));
process.exit(0);
`,
      'utf-8'
    );
    if (process.platform !== 'win32') {
      await chmod(expoBin, 0o755);
    }

    await mkdir(join(storageDir, 'main'), { recursive: true });

    const env = {
      ...process.env,
      // Ensure our xcrun stub wins over /usr/bin/xcrun even after env.mjs normalizes PATH.
      PATH: `${binDir}:/usr/bin:/bin`,
      HAPPIER_STACK_REPO_DIR: repoDir,
      HAPPIER_STACK_HOME_DIR: join(tmp, 'home'),
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_STACK: 'main',
      HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL: '0',
      HAPPIER_STACK_TAILSCALE_SERVE: '0',
      HAPPIER_STACK_ENV_FILE: join(tmp, 'nonexistent-env'),
    };

    const res = await runNodeCapture([mobileScript, '--run-ios', '--no-metro', '--port=14362'], { cwd: rootDir, env });
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const kv = parseKeyValueLines(res.stdout);
    const args = JSON.parse(kv.ARGS ?? '[]');

    assert.ok(!args.includes('--no-bundler'), `expected expo args to not include --no-bundler\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.ok(args.includes('--port'), `expected expo args to include --port\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.ok(!args.includes('-p'), `expected expo args to not include -p\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    const portIdx = args.indexOf('--port');
    assert.ok(portIdx >= 0 && args[portIdx + 1] === '14362', `expected --port 14362\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.equal(
      kv.RCT_METRO_PORT,
      '14362',
      `expected RCT_METRO_PORT to be set from hstack --port\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
    );
    assert.equal(
      kv.EXPO_PACKAGER_PORT,
      '14362',
      `expected EXPO_PACKAGER_PORT to match\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
