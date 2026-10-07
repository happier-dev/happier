import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTempFixture } from '../../../apps/stack/scripts/testkit/core/temp_fixture.mjs';

test('native addon uses an explicitly shared Cargo target for compilation and artifact discovery', { skip: process.platform === 'win32' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-iroh-shared-target-' });
  const bin = join(root, 'bin'), target = join(root, 'cargo-target');
  await mkdir(bin);
  // Cargo is the external process boundary; its fixture emits a real file at
  // the requested target so the real build script must discover that output.
  await writeFile(join(bin, 'cargo'), `#!/bin/sh\n[ "$CARGO_TARGET_DIR" = "$EXPECTED_CARGO_TARGET" ] || exit 23\nwhile [ "$1" != --target ]; do shift; done\nshift\nmkdir -p "$CARGO_TARGET_DIR/$1/release"\nprintf fixture > "$CARGO_TARGET_DIR/$1/release/libhappier_iroh_node.${process.platform === 'darwin' ? 'dylib' : 'so'}"\n`, { mode: 0o755 });
  // Run a copy in scratch so no package-native output is replaced by a fixture.
  const script = new URL('./build-node-addon.mjs', import.meta.url);
  const { readFile } = await import('node:fs/promises');
  const scriptDir = join(root, 'package', 'scripts');
  await mkdir(scriptDir, { recursive: true });
  await writeFile(join(scriptDir, 'build-node-addon.mjs'), await readFile(script));
  const result = spawnSync(process.execPath, [join(scriptDir, 'build-node-addon.mjs'), '--offline'], {
    encoding: 'utf8', env: { ...process.env, PATH: bin + ':' + process.env.PATH, CARGO_TARGET_DIR: target, EXPECTED_CARGO_TARGET: target },
  });
  assert.equal(result.status, 0, result.stderr);
  await access(join(root, 'package', 'native', `happier-iroh-native-lifecycle.${process.platform}-${process.arch}.node`));
});
