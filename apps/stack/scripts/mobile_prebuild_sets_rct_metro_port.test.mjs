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

test('hstack mobile --prebuild sets RCT_METRO_PORT for native build steps', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const mobileScript = join(rootDir, 'scripts', 'mobile.mjs');

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-mobile-port-'));
  const repoDir = join(tmp, 'repo');
  const storageDir = join(tmp, 'storage');

  try {
    const uiDir = join(repoDir, 'apps', 'ui');
    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });

    // Stub Expo CLI so the test doesn't require installing or running the real toolchain.
    await writeFile(
      expoBin,
      `#!/usr/bin/env node
console.log('RCT_METRO_PORT=' + (process.env.RCT_METRO_PORT ?? ''));
console.log('EXPO_PACKAGER_PORT=' + (process.env.EXPO_PACKAGER_PORT ?? ''));
process.exit(0);
`,
      'utf-8'
    );
    if (process.platform !== 'win32') {
      await chmod(expoBin, 0o755);
    }

    // Ensure stack storage stays within this tmp dir (avoid touching real ~/.happier paths).
    await mkdir(join(storageDir, 'main'), { recursive: true });

    const env = {
      ...process.env,
      HAPPIER_STACK_REPO_DIR: repoDir,
      HAPPIER_STACK_HOME_DIR: join(tmp, 'home'),
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_STACK: 'main',
      // Keep resolveServerUrls from probing tailscale in tests.
      HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL: '0',
      HAPPIER_STACK_TAILSCALE_SERVE: '0',
      // Prevent env auto-loading from a real machine stack env file.
      HAPPIER_STACK_ENV_FILE: join(tmp, 'nonexistent-env'),
    };

    const res = await runNodeCapture([mobileScript, '--prebuild', '--platform=android', '--no-metro'], { cwd: rootDir, env });
    const kv = parseKeyValueLines(res.stdout);
    assert.ok(kv.RCT_METRO_PORT, `expected stub expo to print RCT_METRO_PORT\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.equal(
      kv.EXPO_PACKAGER_PORT,
      kv.RCT_METRO_PORT,
      `expected EXPO_PACKAGER_PORT to match RCT_METRO_PORT\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
    );
    assert.notEqual(
      kv.RCT_METRO_PORT,
      '8081',
      `expected native build steps to avoid default Metro port 8081 (more collision-prone)\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

