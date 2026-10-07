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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const crateDir = join(packageDir, "rust", "happier-iroh-node");
// This crate is a member of the package-level Rust workspace, so Cargo writes
// artifacts beneath the workspace target directory rather than `crateDir`.
// Set it explicitly so artifact discovery does not depend on Cargo's workspace
// root inference or the process working directory.
const cargoTargetDir = resolve(process.env.CARGO_TARGET_DIR || join(packageDir, "rust", "target"));
const nativeDir = join(packageDir, "native");
const nativeTestDir = join(packageDir, "native-test");
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

function main() {
  const args = process.argv.slice(2);
  const profile = args.includes("--debug") ? "debug" : "release";
  const musl = args.includes("--musl");
  const testRelayFixture = args.includes("--test-relay-fixture");
  const platform = process.platform;
  const arch = process.arch;
  const target = resolveRustTarget(platform, arch, { musl });

  const cargoArgs = ["build", "--locked", "--manifest-path", join(crateDir, "Cargo.toml"), "--target", target];
  if (profile === "release") {
    cargoArgs.push("--release");
  }
  if (testRelayFixture) {
    cargoArgs.push("--features", "test-relay-fixture");
  }
  if (args.includes("--offline")) {
    cargoArgs.push("--offline");
  }

  const build = spawnSync("cargo", cargoArgs, {
    env: { ...process.env, CARGO_TARGET_DIR: cargoTargetDir },
    stdio: "inherit",
  });
  if (build.error) {
    process.stderr.write(`Unable to start Cargo for the Iroh native addon build: ${build.error.message}\n`);
  }
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }

  const dylib = join(cargoTargetDir, target, profile, DYLIB_NAMES[platform]);
  // Relay-fixture bytes are development-only and must never share the package's
  // publishable `native/` directory with the ordinary lifecycle addon.
  const artifactDir = testRelayFixture ? nativeTestDir : nativeDir;
  const artifact = join(artifactDir, resolveArtifactName(platform, arch, { testRelayFixture }));
  mkdirSync(artifactDir, { recursive: true });
  rmSync(artifact, { force: true });
  copyFileSync(dylib, artifact);
  process.stdout.write(`${artifact} (rust target ${target}, ${profile})\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
