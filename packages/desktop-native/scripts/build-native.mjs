#!/usr/bin/env node
// Builds the `happier-desktop-native` crate and places the resulting cdylib as a
// loadable N-API addon under `native/`.
//
// The crate is a plain napi-rs cdylib, so no napi CLI is required: renaming the
// dylib to `.node` is all Node/Electron needs to load it.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const crateDir = join(packageDir, "rust", "happier-desktop-native");
const nativeDir = join(packageDir, "native");

const RUST_TARGETS = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
};

export function resolveArtifactName(platform, arch) {
  return `happier-desktop-native.${platform}-${arch}.node`;
}

export function resolveRustTarget(platform, arch) {
  const target = RUST_TARGETS[`${platform}-${arch}`];
  if (!target) {
    throw new Error(
      `@happier-dev/desktop-native has no Rust target for ${platform}-${arch}; supported: ${Object.keys(RUST_TARGETS).join(", ")}`,
    );
  }
  return target;
}

function main() {
  const args = process.argv.slice(2);
  const profile = args.includes("--debug") ? "debug" : "release";
  const platform = process.platform;
  const arch = process.arch;
  const target = resolveRustTarget(platform, arch);

  const cargoArgs = ["build", "--manifest-path", join(crateDir, "Cargo.toml"), "--target", target];
  if (profile === "release") {
    cargoArgs.push("--release");
  }
  if (args.includes("--offline")) {
    cargoArgs.push("--offline");
  }

  const build = spawnSync("cargo", cargoArgs, { stdio: "inherit" });
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }

  const dylib = join(crateDir, "target", target, profile, "libhappier_desktop_native.dylib");
  const artifact = join(nativeDir, resolveArtifactName(platform, arch));
  mkdirSync(nativeDir, { recursive: true });
  rmSync(artifact, { force: true });
  copyFileSync(dylib, artifact);
  process.stdout.write(`${artifact}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
