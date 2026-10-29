#!/usr/bin/env node
// Establishes the pinned Rust prerequisites a mobile build needs before Gradle
// or CocoaPods reaches `build-rust-android.sh` / `build-rust-ios.sh`
// (Lane 06 amendment A10).
//
// This runs as the EAS `eas-build-pre-install` lifecycle hook, which cloud and
// local EAS builds execute alike, so one hook serves both the EAS images and
// the GitHub-hosted runners the local mode builds on. What each image is
// missing differs and is detected rather than assumed:
//
//   - EAS Android/iOS images document Node, Bun, package managers, Java/NDK and
//     Xcode/Ruby/CocoaPods/fastlane, and no Rust at all;
//   - GitHub-hosted `ubuntu-24.04` and `macos-26` ship rustup with a stable
//     Rust that is not the pin, and no cross-compilation targets.
//
// The channel itself lives in `rust-toolchain.toml` next to this package, so a
// `cargo` call made by Gradle or a podspec — which no pipeline step wraps — uses
// the pinned compiler without anyone remembering to select it.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * The exact targets the Iroh native build scripts compile for each platform,
 * plus the browser boundary's target. `ensure-rust-toolchain.test.mjs` holds
 * these against the build scripts themselves, so a new ABI cannot be added on
 * one side only and fail the release build with a missing std.
 */
export const IROH_RUST_TARGETS = Object.freeze({
  host: Object.freeze([]),
  ios: Object.freeze(['aarch64-apple-ios', 'aarch64-apple-ios-sim', 'x86_64-apple-ios']),
  android: Object.freeze(['aarch64-linux-android', 'x86_64-linux-android']),
  browser: Object.freeze(['wasm32-unknown-unknown']),
});

const PACKAGE_ROOT = new URL('../', import.meta.url);

export function readPinnedRustChannel(toolchainFile) {
  const channel = toolchainFile.match(/^channel\s*=\s*"([^"]+)"$/mu)?.[1];
  if (!channel) throw new Error('rust-toolchain.toml does not pin a channel');
  return channel;
}

/**
 * What this build host still needs, as commands to run in order.
 *
 * `installScope` is the build's `HAPPIER_INSTALL_SCOPE`: a build that does not
 * install the Iroh native module never compiles Rust, so it needs nothing.
 */
export function resolveRustToolchainPlan({ platform, channel, hasRustup, installScope }) {
  const targets = IROH_RUST_TARGETS[String(platform ?? '').trim().toLowerCase()];
  if (!targets) {
    return { status: 'skipped', reason: `no Iroh Rust targets for build platform '${platform}'`, commands: [] };
  }

  const scope = String(installScope ?? '').trim();
  if (platform !== 'host' && scope && !scope.split(',').map((entry) => entry.trim()).includes('iroh-native')) {
    return {
      status: 'skipped',
      reason: `HAPPIER_INSTALL_SCOPE excludes iroh-native, so no Rust build runs (${scope})`,
      commands: [],
    };
  }

  const commands = hasRustup
    ? [{ command: 'rustup', args: ['toolchain', 'install', channel, '--profile', 'minimal'] }]
    : [{
      command: 'sh',
      args: [
        '-c',
        'curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs '
        + `| sh -s -- -y --no-modify-path --profile minimal --default-toolchain ${channel}`,
      ],
    }];
  if (targets.length > 0) commands.push({ command: 'rustup', args: ['target', 'add', '--toolchain', channel, ...targets] });
  return { status: 'install', targets: [...targets], commands };
}

export function resolveRustCargoBinDir(env = process.env) {
  return join(env.CARGO_HOME || join(env.HOME || env.USERPROFILE || homedir(), '.cargo'), 'bin');
}

export function prepareRustToolchain({ platform, channel, env = process.env }) {
  const cargoBin = resolveRustCargoBinDir(env);
  const rustup = spawnSync('rustup', ['--version'], { env, stdio: 'ignore' }).status === 0
    ? 'rustup' : join(cargoBin, 'rustup');
  const hasRustup = spawnSync(rustup, ['--version'], { env, stdio: 'ignore' }).status === 0;
  const plan = resolveRustToolchainPlan({
    platform,
    channel,
    hasRustup,
    installScope: env.HAPPIER_INSTALL_SCOPE,
  });

  if (plan.status === 'skipped') {
    process.stdout.write(`[iroh-native] Rust toolchain setup skipped: ${plan.reason}\n`);
    return;
  }

  if (platform === 'host' && hasRustup
    && spawnSync(rustup, ['run', channel, 'rustc', '--version'], { env, stdio: 'ignore' }).status === 0) {
    process.stdout.write(`[iroh-native] Rust ${channel} ready for native host\n`);
    return;
  }

  process.stdout.write(
    `[iroh-native] preparing Rust ${channel} for ${platform}: ${plan.targets.join(', ')}\n`,
  );
  for (const { command, args } of plan.commands) {
    // `~/.cargo/bin` is only on PATH for later steps once rustup has installed
    // it, so the freshly installed rustup is invoked from its known location.
    const executable = command === 'rustup'
      ? rustup
      : command;
    const result = spawnSync(executable, args, { env, stdio: 'inherit' });
    if (result.status !== 0) {
      throw new Error(`${command} ${args.join(' ')} failed with status ${result.status ?? result.error}`);
    }
  }
  if (platform === 'host') {
    const compiler = spawnSync(rustup, ['run', channel, 'rustc', '--version'], { env, stdio: 'inherit' });
    if (compiler.status !== 0) throw new Error(`Rust ${channel} is unavailable after preparation`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  const platformIndex = argv.indexOf('--platform');
  const platform = platformIndex === -1 ? process.env.EAS_BUILD_PLATFORM : argv[platformIndex + 1];
  const channel = readPinnedRustChannel(
    readFileSync(fileURLToPath(new URL('rust-toolchain.toml', PACKAGE_ROOT)), 'utf8'),
  );
  prepareRustToolchain({ platform, channel });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
