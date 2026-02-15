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

test('hstack mobile --run-ios passes -p/--port to Expo (avoids default 8081)', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const mobileScript = join(rootDir, 'scripts', 'mobile.mjs');

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-mobile-runios-port-'));
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

    // Stub Expo CLI: print argv + env-derived ports and exit successfully.
    // Use an absolute node shebang so the test can safely clear PATH.
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
      // Ensure xcrun runs fast/deterministically in tests.
      PATH: binDir,
      HAPPIER_STACK_REPO_DIR: repoDir,
      HAPPIER_STACK_HOME_DIR: join(tmp, 'home'),
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_STACK: 'main',
      HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL: '0',
      HAPPIER_STACK_TAILSCALE_SERVE: '0',
      HAPPIER_STACK_ENV_FILE: join(tmp, 'nonexistent-env'),
    };

    const res = await runNodeCapture([mobileScript, '--run-ios', '--no-metro'], { cwd: rootDir, env });
    const kv = parseKeyValueLines(res.stdout);

    const args = JSON.parse(kv.ARGS ?? '[]');
    const port = kv.RCT_METRO_PORT ?? '';

    assert.ok(port, `expected RCT_METRO_PORT to be set\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.equal(kv.EXPO_PACKAGER_PORT, port, `expected EXPO_PACKAGER_PORT to match\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.ok(args.includes('-p') || args.includes('--port'), `expected expo args to include -p/--port\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    const pIdx = args.indexOf('-p') !== -1 ? args.indexOf('-p') : args.indexOf('--port');
    assert.equal(args[pIdx + 1], port, `expected expo -p to match RCT_METRO_PORT\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.notEqual(port, '8081', `expected non-default port to reduce collisions\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

