import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function runHstack(args, { env } = {}) {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(testDir, '..', '..', '..');
  const hstackBin = resolve(repoRoot, 'apps', 'stack', 'bin', 'hstack.mjs');

  return spawnSync(process.execPath, [hstackBin, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
      HAPPIER_STACK_UPDATE_CHECK: '0',
      ...env,
    },
    encoding: 'utf8',
  });
}

test('hstack menubar uninstall removes only hstack plugins', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-menubar-uninstall-'));
  try {
    const pluginsDir = join(tmp, 'plugins');
    await mkdir(pluginsDir, { recursive: true });

    const legacyHstackPlugin = join(pluginsDir, 'happy-stacks.5m.sh');
    const current = join(pluginsDir, 'hstack.5m.sh');

    await writeFile(legacyHstackPlugin, '#!/bin/bash\necho legacy\n', 'utf8');
    await writeFile(current, '#!/bin/bash\necho current\n', 'utf8');
    assert.ok(existsSync(legacyHstackPlugin));
    assert.ok(existsSync(current));

    const res = runHstack(['menubar', 'uninstall', '--json'], {
      env: {
        HAPPIER_STACK_SWIFTBAR_PLUGINS_DIR: pluginsDir,
        HAPPIER_STACK_SWIFTBAR_ALLOW_OVERRIDE_NON_DARWIN: '1',
      },
    });
    assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

    assert.ok(existsSync(legacyHstackPlugin), 'expected legacy hstack plugin preserved');
    assert.ok(!existsSync(current), 'expected current plugin removed');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
