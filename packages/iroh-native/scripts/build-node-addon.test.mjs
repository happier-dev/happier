import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTempFixture } from '../../../apps/stack/scripts/testkit/core/temp_fixture.mjs';
import { buildNodeAddon, resolveArtifactName, resolveRustTarget } from './build-node-addon.mjs';

test('native addon uses an explicitly shared Cargo target for compilation and artifact discovery', { skip: process.platform === 'win32' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-iroh-shared-target-' });
  const bin = join(root, 'bin'), target = join(root, 'cargo-target');
  await mkdir(bin);
  // Cargo is the external process boundary; its fixture emits a real file at
  // the requested target so the real build script must discover that output.
  await writeFile(join(bin, 'cargo'), `#!/bin/sh\n[ "$CARGO_TARGET_DIR" = "$EXPECTED_CARGO_TARGET" ] || exit 23\nwhile [ "$1" != --target ]; do shift; done\nshift\nmkdir -p "$CARGO_TARGET_DIR/$1/release"\nprintf fixture > "$CARGO_TARGET_DIR/$1/release/libhappier_iroh_node.${process.platform === 'darwin' ? 'dylib' : 'so'}"\n`, { mode: 0o755 });
  // Run copies of the real builder and its toolchain helper in scratch so no
  // package-native output is replaced by a fixture.
  const scriptDir = join(root, 'package', 'scripts');
  await mkdir(scriptDir, { recursive: true });
  for (const name of ['build-node-addon.mjs', 'ensure-rust-toolchain.mjs']) {
    await writeFile(join(scriptDir, name), await readFile(new URL(name, import.meta.url)));
  }
  const result = spawnSync(process.execPath, [join(scriptDir, 'build-node-addon.mjs'), '--offline'], {
    encoding: 'utf8', env: { ...process.env, PATH: bin + ':' + process.env.PATH, CARGO_TARGET_DIR: target, EXPECTED_CARGO_TARGET: target },
  });
  assert.equal(result.status, 0, result.stderr);
  await access(join(root, 'package', 'native', `happier-iroh-native-lifecycle.${process.platform}-${process.arch}.node`));
});

for (const [platform, arch, rustTarget, dylib] of [
  ['linux', 'x64', 'x86_64-unknown-linux-gnu', 'libhappier_iroh_node.so'],
  ['linux', 'arm64', 'aarch64-unknown-linux-gnu', 'libhappier_iroh_node.so'],
  ['darwin', 'x64', 'x86_64-apple-darwin', 'libhappier_iroh_node.dylib'],
  ['darwin', 'arm64', 'aarch64-apple-darwin', 'libhappier_iroh_node.dylib'],
  ['win32', 'x64', 'x86_64-pc-windows-msvc', 'happier_iroh_node.dll'],
]) test(`isolated addon staging uses the canonical ${platform}-${arch} target`, async t => {
  const { root } = await createTempFixture(t, { prefix: 'happier-addon-stage-' });
  const packageDir = join(root, 'captured-package');
  const artifactDir = join(root, 'runtime/native');
  const cargoTargetDir = join(root, 'cargo');
  const bytes = Buffer.from([0, 255, 4, 128]);
  const artifact = await buildNodeAddon({ packageDir, artifactDir, cargoTargetDir, platform, arch,
    runCommand: async (command, args, options) => {
      assert.equal(command, 'cargo');
      assert.equal(options.cwd, packageDir);
      assert.equal(args[args.indexOf('--target') + 1], rustTarget);
      assert.equal(options.env.CARGO_TARGET_DIR, cargoTargetDir);
      const output = join(cargoTargetDir, rustTarget, 'release', dylib);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, bytes);
    } });
  assert.equal(artifact, join(artifactDir, resolveArtifactName(platform, arch)));
  assert.deepEqual(await readFile(artifact), bytes);
});

test('a Cargo failure never publishes an addon', async t => {
  const { root } = await createTempFixture(t, { prefix: 'happier-addon-refusal-' });
  const failure = new Error('Cargo refused the source');
  await assert.rejects(buildNodeAddon({ packageDir: root, artifactDir: join(root, 'native'),
    runCommand: async () => { throw failure; } }), error => error === failure);
  await assert.rejects(readFile(join(root, 'native', resolveArtifactName(process.platform, process.arch))), { code: 'ENOENT' });
});

test('musl retains canonical Node artifact naming and only changes the Cargo target', () => {
  assert.equal(resolveRustTarget('linux', 'arm64', { musl: true }), 'aarch64-unknown-linux-musl');
  assert.equal(resolveArtifactName('linux', 'arm64'), 'happier-iroh-native-lifecycle.linux-arm64.node');
  assert.throws(() => resolveRustTarget('darwin', 'arm64', { musl: true }));
});

test('addon builds can use the provisioned user Cargo bin without changing existing Path precedence', async t => {
  const { root } = await createTempFixture(t, { prefix: 'happier-addon-cargo-env-' });
  const stopped = new Error('stop at Cargo boundary');
  await assert.rejects(buildNodeAddon({ packageDir: root,
    env: { Path: '/existing-tools', CARGO_HOME: join(root, 'cargo-home') },
    runCommand: async (_command, _args, options) => {
      const { delimiter } = await import('node:path');
      assert.equal(options.env.Path, `/existing-tools${delimiter}${join(root, 'cargo-home/bin')}`);
      assert.equal(Object.hasOwn(options.env, 'PATH'), false);
      throw stopped;
    } }), error => error === stopped);
});
