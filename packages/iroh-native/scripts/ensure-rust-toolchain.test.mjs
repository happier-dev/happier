import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createTempFixture } from '../../../apps/stack/scripts/testkit/core/temp_fixture.mjs';

import {
  IROH_RUST_TARGETS,
  readPinnedRustChannel,
  resolveRustToolchainPlan,
} from './ensure-rust-toolchain.mjs';
import { WASM_TARGET } from './verify-browser-iroh-wasm.mjs';

const packageRoot = new URL('../', import.meta.url);
const repoRoot = new URL('../../../', import.meta.url);

async function read(base, relativePath) {
  return readFile(new URL(relativePath, base), 'utf8');
}

test('the pinned channel is read from the Rust workspace that owns the build', async () => {
  // The Gradle task and the CocoaPods prepare command invoke `cargo` directly,
  // so no pipeline step wraps them. A toolchain file next to the package is
  // what actually pins the compiler those builds use.
  const channel = readPinnedRustChannel(await read(packageRoot, 'rust-toolchain.toml'));
  const appChannel = readPinnedRustChannel(await read(repoRoot, 'apps/ui/rust-toolchain.toml'));

  assert.match(channel, /^\d+\.\d+\.\d+$/u);
  assert.equal(channel, appChannel, 'one Rust channel serves the whole product build');
});

test('an EAS image without Rust gets rustup, the pinned toolchain and the platform targets', () => {
  // EAS build images document Node, Bun, Yarn, pnpm, npm, Java/NDK (Android) and
  // Xcode/Ruby/CocoaPods/fastlane (iOS) — no Rust of any kind.
  const plan = resolveRustToolchainPlan({ platform: 'android', channel: '1.94.1', hasRustup: false });

  assert.equal(plan.status, 'install');
  assert.deepEqual(plan.targets, IROH_RUST_TARGETS.android);
  assert.match(plan.commands[0].args.join(' '), /sh\.rustup\.rs/u);
  assert.match(plan.commands[0].args.join(' '), /--default-toolchain 1\.94\.1/u);
  assert.deepEqual(
    plan.commands.at(-1),
    { command: 'rustup', args: ['target', 'add', '--toolchain', '1.94.1', ...IROH_RUST_TARGETS.android] },
  );
});

test('a runner image that already ships rustup only adds the pinned toolchain and targets', () => {
  // GitHub-hosted ubuntu-24.04 and macos-26 ship Rustup with a stable Rust that
  // is not the pin, and no cross-compilation targets.
  const plan = resolveRustToolchainPlan({ platform: 'ios', channel: '1.94.1', hasRustup: true });

  assert.equal(plan.status, 'install');
  assert.deepEqual(plan.targets, IROH_RUST_TARGETS.ios);
  assert.deepEqual(plan.commands, [
    { command: 'rustup', args: ['toolchain', 'install', '1.94.1', '--profile', 'minimal'] },
    { command: 'rustup', args: ['target', 'add', '--toolchain', '1.94.1', ...IROH_RUST_TARGETS.ios] },
  ]);
});

test('a build that does not install the Iroh native module needs no Rust at all', () => {
  const plan = resolveRustToolchainPlan({
    platform: 'android',
    channel: '1.94.1',
    hasRustup: true,
    installScope: 'ui,protocol,agents',
  });

  assert.equal(plan.status, 'skipped');
  assert.deepEqual(plan.commands, []);
  assert.match(plan.reason, /iroh-native/u);
});

test('an unrecognised build platform is a no-op rather than a guess', () => {
  const plan = resolveRustToolchainPlan({ platform: '', channel: '1.94.1', hasRustup: true });
  assert.equal(plan.status, 'skipped');
  assert.deepEqual(plan.commands, []);
});

test('a native host prepares only its pinned compiler, without mobile or WASM targets', () => {
  for (const hasRustup of [false, true]) {
    const plan = resolveRustToolchainPlan({ platform: 'host', channel: '1.94.1', hasRustup });
    assert.equal(plan.status, 'install');
    assert.deepEqual(plan.targets, []);
    assert.equal(plan.commands.length, 1);
    assert.match(plan.commands[0].args.join(' '), /1\.94\.1/u);
  }
});

test('native host setup finds user-local rustup off PATH, verifies the pin and reuses a ready compiler', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-native-rust-' });
  const cargoHome = join(root, 'cargo');
  await mkdir(join(cargoHome, 'bin'), { recursive: true });
  await mkdir(join(root, 'empty-path'));
  const channel = readPinnedRustChannel(await read(packageRoot, 'rust-toolchain.toml'));
  // rustup is the external executable boundary. No compiler, network installer,
  // account or system package is changed by this fixture.
  await writeFile(join(cargoHome, 'bin/rustup'), `#!/bin/sh
case "$*" in
  --version) echo fixture-rustup ;;
  'run ${channel} rustc --version') [ -f "$CARGO_HOME/ready" ] && echo fixture-rustc ;;
  'toolchain install ${channel} --profile minimal')
    printf '%s\\n' "$*" >> "$CARGO_HOME/installs"
    echo fixture-install-progress
    [ "\${TEST_FAIL_RUST:-0}" = 1 ] || printf ready > "$CARGO_HOME/ready" ;;
  *) exit 79 ;;
esac
`, { mode: 0o755 });
  const run = extraEnv => spawnSync(process.execPath, [fileURLToPath(new URL('./ensure-rust-toolchain.mjs', import.meta.url)), '--platform', 'host'], {
    encoding: 'utf8', env: { ...process.env, CARGO_HOME: cargoHome, PATH: join(root, 'empty-path'), ...extraEnv },
  });
  const broken = run({ TEST_FAIL_RUST: '1' });
  assert.notEqual(broken.status, 0, 'an installer success without the pinned compiler must fail');
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const installs = await readFile(join(cargoHome, 'installs'), 'utf8');
  assert.ok(installs.includes(channel));
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  // Callers such as the source-runtime producer parse this process's stdout as a
  // protocol channel, so progress is diagnostic output on stderr only.
  assert.equal(first.stdout, '', 'toolchain progress must not write to stdout');
  assert.equal(second.stdout, '', 'toolchain progress must not write to stdout');
  assert.equal(await readFile(join(cargoHome, 'installs'), 'utf8'), installs, 'a ready compiler must not be reinstalled');
});

test('a provisioned toolchain with every requested target is reused offline, not re-synced', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-native-rust-targets-' });
  const cargoHome = join(root, 'cargo');
  await mkdir(join(cargoHome, 'bin'), { recursive: true });
  await mkdir(join(root, 'empty-path'));
  const channel = readPinnedRustChannel(await read(packageRoot, 'rust-toolchain.toml'));
  // rustup is the external executable boundary. Any channel sync or target add
  // reaches the network (windows2-linux has none), so the fixture records them.
  await writeFile(join(cargoHome, 'bin/rustup'), `#!/bin/sh
case "$*" in
  --version) echo fixture-rustup ;;
  'run ${channel} rustc --version') echo fixture-rustc ;;
  'target list --toolchain ${channel} --installed') while IFS= read -r line; do echo "$line"; done < "$CARGO_HOME/installed-targets" ;;
  'toolchain install '*|'target add '*) printf '%s\\n' "$*" >> "$CARGO_HOME/network" ;;
  *) exit 79 ;;
esac
`, { mode: 0o755 });
  const run = () => spawnSync(process.execPath, [fileURLToPath(new URL('./ensure-rust-toolchain.mjs', import.meta.url)), '--platform', 'session-targets'], {
    encoding: 'utf8', env: { ...process.env, CARGO_HOME: cargoHome, PATH: join(root, 'empty-path') },
  });
  const [missing, ...present] = IROH_RUST_TARGETS['session-targets'];
  await writeFile(join(cargoHome, 'installed-targets'), `x86_64-unknown-linux-gnu\n${present.join('\n')}\n`);
  const partial = run();
  assert.equal(partial.status, 0, partial.stderr);
  assert.match(await readFile(join(cargoHome, 'network'), 'utf8'), new RegExp(`target add --toolchain ${channel} .*${missing}`, 'u'),
    'a missing target is still installed');
  await writeFile(join(cargoHome, 'network'), '');
  await writeFile(join(cargoHome, 'installed-targets'), `x86_64-unknown-linux-gnu\n${IROH_RUST_TARGETS['session-targets'].join('\n')}\n`);
  const ready = run();
  assert.equal(ready.status, 0, ready.stderr);
  assert.equal(ready.stdout, '', 'toolchain progress must not write to stdout');
  assert.equal(await readFile(join(cargoHome, 'network'), 'utf8'), '', 'a ready toolchain and targets must not reach the network');
});

test('the declared targets are exactly the ones the Iroh build scripts compile', async () => {
  const [ios, android] = await Promise.all([
    read(packageRoot, 'scripts/build-rust-ios.sh'),
    read(packageRoot, 'scripts/build-rust-android.sh'),
  ]);

  assert.deepEqual(
    [...ios.matchAll(/--target (\S+)/gu)].map((match) => match[1]).sort(),
    [...IROH_RUST_TARGETS.ios].sort(),
  );
  assert.deepEqual(
    [...android.matchAll(/^build_target\s+"([^"]+)"/gmu)].map((match) => match[1]).sort(),
    [...IROH_RUST_TARGETS.android].sort(),
  );
  assert.deepEqual(IROH_RUST_TARGETS.browser, [WASM_TARGET]);
});

test('mobile Rust build scripts can consume a toolchain installed by an earlier EAS lifecycle step', async () => {
  // `eas-build-pre-install` executes in its own shell. When it bootstraps
  // rustup with `--no-modify-path`, the later Gradle/CocoaPods shell does not
  // inherit that process's PATH. The actual native build boundary therefore
  // has to load Cargo's persisted environment before invoking `cargo`.
  const [ios, android] = await Promise.all([
    read(packageRoot, 'scripts/build-rust-ios.sh'),
    read(packageRoot, 'scripts/build-rust-android.sh'),
  ]);

  for (const script of [ios, android]) {
    assert.match(script, /CARGO_HOME:-\$\{HOME\}\/\.cargo/u);
    assert.match(script, /source "\$\{RUST_ENV\}"/u);
    assert.match(script, /command -v cargo/u);
  }
});

test('the mobile pipelines establish the prerequisite through the EAS build lifecycle hook', async () => {
  // Cloud and local EAS builds run the same lifecycle, so one hook covers both
  // the EAS images and the GitHub-hosted runners the local mode builds on.
  const manifest = JSON.parse(await read(repoRoot, 'apps/ui/package.json'));
  assert.match(
    manifest.scripts['eas-build-pre-install'],
    /packages\/iroh-native\/scripts\/ensure-rust-toolchain\.mjs/u,
  );
});
