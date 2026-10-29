#!/usr/bin/env node
// Builds the `happier-iroh-node` NAPI crate for the current host and installs
// the cdylib as the deterministic lifecycle addon artifact
// `native/happier-iroh-native-lifecycle.<platform>-<arch>.node`.
//
// The crate is a plain napi-rs cdylib, so no napi CLI is required: renaming
// the dylib is all Node and Bun need to load it. Linux defaults to the gnu
// Rust targets; pass `--musl` on musl hosts (the artifact name stays
// platform-arch because one host has exactly one libc).
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRustCargoBinDir } from "./ensure-rust-toolchain.mjs";

const defaultPackageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const crateLibName = "happier_iroh_node";

const DYLIB_NAMES = {
  darwin: `lib${crateLibName}.dylib`,
  linux: `lib${crateLibName}.so`,
  win32: `${crateLibName}.dll`,
};

const RUST_TARGETS = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "win32-x64": "x86_64-pc-windows-msvc",
};

export function resolveArtifactName(platform, arch, { testRelayFixture = false } = {}) {
  const suffix = testRelayFixture ? "-test" : "";
  return `happier-iroh-native-lifecycle${suffix}.${platform}-${arch}.node`;
}

export function resolveRustTarget(platform, arch, { musl = false } = {}) {
  const base = RUST_TARGETS[`${platform}-${arch}`];
  if (!base) {
    throw new Error(
      `@happier-dev/iroh-native has no Rust target for ${platform}-${arch}; supported: ${Object.keys(RUST_TARGETS).join(", ")}`,
    );
  }
  if (musl) {
    if (platform !== "linux") {
      throw new Error(`--musl applies only to Linux targets, not ${platform}-${arch}`);
    }
    return base.replace(/-gnu$/, "-musl");
  }
  return base;
}

async function runCargo(command, args, options) {
  const build = spawnSync(command, args, { ...options, stdio: "inherit" });
  if (build.error) throw build.error;
  if (build.status !== 0) {
    throw Object.assign(new Error(`Cargo failed with status ${build.status ?? "unknown"}`), {
      exitCode: build.status ?? 1,
    });
  }
}

// Source runtime construction and the standalone command share this builder.
// Cargo scratch may be reused; every consumer receives its own physical addon.
export async function buildNodeAddon({
  packageDir = defaultPackageDir,
  env = process.env,
  cargoTargetDir = resolve(env.CARGO_TARGET_DIR || join(packageDir, "rust", "target")),
  testRelayFixture = false,
  artifactDir = join(packageDir, testRelayFixture ? "native-test" : "native"),
  platform = process.platform,
  arch = process.arch,
  profile = "release",
  musl = false,
  offline = false,
  runCommand = runCargo,
} = {}) {
  const target = resolveRustTarget(platform, arch, { musl });
  const crateDir = join(packageDir, "rust", "happier-iroh-node");
  const cargoArgs = ["build", "--locked", "--manifest-path", join(crateDir, "Cargo.toml"), "--target", target];
  if (profile === "release") {
    cargoArgs.push("--release");
  }
  if (testRelayFixture) {
    cargoArgs.push("--features", "test-relay-fixture");
  }
  if (offline) {
    cargoArgs.push("--offline");
  }

  const pathName = Object.keys(env).find(name => name.toUpperCase() === 'PATH') || 'PATH';
  await runCommand("cargo", cargoArgs, {
    cwd: packageDir,
    env: { ...env, CARGO_TARGET_DIR: cargoTargetDir,
      [pathName]: [env[pathName], resolveRustCargoBinDir(env)].filter(Boolean).join(delimiter) },
  });

  const dylib = join(cargoTargetDir, target, profile, DYLIB_NAMES[platform]);
  // Relay-fixture bytes are development-only and must never share the package's
  // publishable `native/` directory with the ordinary lifecycle addon.
  const artifact = join(artifactDir, resolveArtifactName(platform, arch, { testRelayFixture }));
  mkdirSync(artifactDir, { recursive: true });
  rmSync(artifact, { force: true });
  copyFileSync(dylib, artifact);
  return artifact;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  try {
    const profile = args.includes("--debug") ? "debug" : "release";
    const musl = args.includes("--musl");
    const artifact = await buildNodeAddon({ profile, musl,
      testRelayFixture: args.includes("--test-relay-fixture"), offline: args.includes("--offline") });
    process.stdout.write(`${artifact} (rust target ${resolveRustTarget(process.platform, process.arch, { musl })}, ${profile})\n`);
  } catch (error) {
    process.stderr.write(`Unable to build the Iroh native addon: ${error.message}\n`);
    process.exitCode = error.exitCode ?? 1;
  }
}
