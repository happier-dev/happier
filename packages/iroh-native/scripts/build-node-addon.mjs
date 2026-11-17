#!/usr/bin/env node
// Builds the `happier-iroh-node` NAPI crate for the current host and installs
// the cdylib as the deterministic lifecycle addon artifact
// `native/happier-iroh-native-lifecycle.<platform>-<arch>.node`, then builds the
// per-Session holder executable beside it as
// `native/happier-session-holder.<platform>-<arch>[.exe]` (static on Linux and
// Windows, so it also runs in images without glibc/MSVC runtimes).
//
// The crate is a plain napi-rs cdylib, so no napi CLI is required: renaming
// the dylib is all Node and Bun need to load it. Linux defaults to the gnu
// Rust targets; pass `--musl` on musl hosts (the artifact name stays
// platform-arch because one host has exactly one libc).
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareRustToolchain, readPinnedRustChannel, resolveRustCargoBinDir } from "./ensure-rust-toolchain.mjs";
import { readFileSync } from "node:fs";

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

/**
 * Holders for Session execution targets (Linux containers/sandboxes reached
 * through a Machine provider; P03 placement "target"). Every build ships both,
 * whatever its host, because any Machine can drive a Linux container of either
 * architecture. Static musl runs unchanged on glibc and musl images.
 */
export const SESSION_TARGET_HOLDER_RUST_TARGETS = Object.freeze({
  x64: "x86_64-unknown-linux-musl",
  arm64: "aarch64-unknown-linux-musl",
});

export function resolveSessionTargetHolderArtifactName(arch) {
  return `targets/happier-session-holder.linux-${arch}-musl`;
}

/** Cross-linking with the toolchain's own lld needs no per-host C cross toolchain. */
const SESSION_TARGET_HOLDER_RUST_FLAGS = "-C linker=rust-lld -C link-self-contained=yes";

export function resolveSessionHolderArtifactName(platform, arch) {
  return `happier-session-holder.${platform}-${arch}${platform === "win32" ? ".exe" : ""}`;
}

/**
 * `crt-static` makes the gnu/msvc holder self-contained (musl is static by
 * default; macOS links libSystem, which every macOS has). It is passed only to
 * the holder's own cargo invocation; the addon is a cdylib and must stay dynamic.
 */
export function resolveSessionHolderRustFlags(target) {
  return /-linux-gnu$|-windows-msvc$/.test(target) ? "-C target-feature=+crt-static" : "";
}

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
  // Callers import this builder and own their stdout; Cargo output is diagnostic.
  const build = spawnSync(command, args, { ...options, stdio: ["inherit", 2, "inherit"] });
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
  prepareTargetToolchain = prepareSessionTargetToolchain,
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
  if (!testRelayFixture) {
    await buildSessionHolder({ packageDir, env, cargoTargetDir, artifactDir, platform, arch, profile, musl, offline, runCommand });
    await buildSessionTargetHolders({ packageDir, env, cargoTargetDir, artifactDir, profile, offline, runCommand, prepareTargetToolchain });
  }
  return artifact;
}

function prepareSessionTargetToolchain({ packageDir, env }) {
  const channel = readPinnedRustChannel(readFileSync(join(packageDir, "rust-toolchain.toml"), "utf8"));
  prepareRustToolchain({ platform: "session-targets", channel, env });
}

export async function buildSessionTargetHolders({
  packageDir = defaultPackageDir,
  /** The target architectures to build (default: every one). */
  arches = Object.keys(SESSION_TARGET_HOLDER_RUST_TARGETS),
  env = process.env,
  cargoTargetDir = resolve(env.CARGO_TARGET_DIR || join(packageDir, "rust", "target")),
  artifactDir = join(packageDir, "native"),
  profile = "release",
  offline = false,
  runCommand = runCargo,
  prepareTargetToolchain = prepareSessionTargetToolchain,
} = {}) {
  // Preparation may download the two musl standard libraries; an offline build uses what is installed.
  if (!offline) await prepareTargetToolchain({ packageDir, env });
  const pathName = Object.keys(env).find(name => name.toUpperCase() === 'PATH') || 'PATH';
  const artifacts = [];
  for (const arch of arches) {
    const target = SESSION_TARGET_HOLDER_RUST_TARGETS[arch];
    if (!target) throw new Error(`No Session target holder for ${arch}`);
    const cargoArgs = ["build", "--locked", "--manifest-path", join(packageDir, "rust", "happier-session-holder", "Cargo.toml"),
      "--bin", "happier-session-holder", "--target", target];
    if (profile === "release") cargoArgs.push("--release");
    if (offline) cargoArgs.push("--offline");
    await runCommand("cargo", cargoArgs, {
      cwd: packageDir,
      env: { ...env, CARGO_TARGET_DIR: cargoTargetDir, RUSTFLAGS: SESSION_TARGET_HOLDER_RUST_FLAGS,
        [pathName]: [env[pathName], resolveRustCargoBinDir(env)].filter(Boolean).join(delimiter) },
    });
    const artifact = join(artifactDir, resolveSessionTargetHolderArtifactName(arch));
    mkdirSync(dirname(artifact), { recursive: true });
    rmSync(artifact, { force: true });
    copyFileSync(join(cargoTargetDir, target, profile, "happier-session-holder"), artifact);
    chmodSync(artifact, 0o755);
    artifacts.push(artifact);
  }
  return artifacts;
}

/**
 * Everything the host Session holder build reads: the holder crate's sources and
 * manifest, the workspace manifest and lock, the Rust pin, the target triple,
 * profile and flags. Source preparation keys holder readiness on this identity.
 */
export function readSessionHolderInputIdentity({
  packageDir = defaultPackageDir,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  profile = "release",
  musl = false,
} = {}) {
  const target = resolveRustTarget(platform, arch, { musl });
  return readHolderInputIdentity({ packageDir, target, profile,
    rustFlags: [env.RUSTFLAGS, resolveSessionHolderRustFlags(target)].filter(Boolean).join(" ") });
}

/** The same identity for a Session target holder (`buildSessionTargetHolders`: its musl target and flags). */
export function readSessionTargetHolderInputIdentity({ packageDir = defaultPackageDir, arch, profile = "release" }) {
  const target = SESSION_TARGET_HOLDER_RUST_TARGETS[arch];
  if (!target) throw new Error(`No Session target holder for ${arch}`);
  return readHolderInputIdentity({ packageDir, target, profile, rustFlags: SESSION_TARGET_HOLDER_RUST_FLAGS });
}

function readHolderInputIdentity({ packageDir, target, profile, rustFlags }) {
  const hash = createHash("sha256").update(JSON.stringify({ target, profile, rustFlags }));
  const add = relativePath => {
    let bytes = null;
    try { bytes = readFileSync(join(packageDir, relativePath)); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    hash.update(relativePath).update("\0").update(bytes ?? "<absent>").update("\0");
  };
  for (const file of ["rust-toolchain.toml", "rust/Cargo.toml", "rust/Cargo.lock", "rust/happier-session-holder/Cargo.toml"]) add(file);
  const visit = relativeDir => {
    let entries;
    try { entries = readdirSync(join(packageDir, relativeDir), { withFileTypes: true }); }
    catch (error) { if (error?.code === "ENOENT") return; throw error; }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const relativePath = `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) visit(relativePath);
      else add(relativePath);
    }
  };
  visit("rust/happier-session-holder/src");
  return hash.digest("hex");
}

export async function buildSessionHolder({
  packageDir = defaultPackageDir,
  env = process.env,
  cargoTargetDir = resolve(env.CARGO_TARGET_DIR || join(packageDir, "rust", "target")),
  artifactDir = join(packageDir, "native"),
  platform = process.platform,
  arch = process.arch,
  profile = "release",
  musl = false,
  offline = false,
  runCommand = runCargo,
} = {}) {
  const target = resolveRustTarget(platform, arch, { musl });
  const cargoArgs = ["build", "--locked", "--manifest-path", join(packageDir, "rust", "happier-session-holder", "Cargo.toml"),
    "--bin", "happier-session-holder", "--target", target];
  if (profile === "release") cargoArgs.push("--release");
  if (offline) cargoArgs.push("--offline");
  const pathName = Object.keys(env).find(name => name.toUpperCase() === 'PATH') || 'PATH';
  const rustFlags = resolveSessionHolderRustFlags(target);
  await runCommand("cargo", cargoArgs, {
    cwd: packageDir,
    env: { ...env, CARGO_TARGET_DIR: cargoTargetDir,
      ...(rustFlags ? { RUSTFLAGS: [env.RUSTFLAGS, rustFlags].filter(Boolean).join(" ") } : {}),
      [pathName]: [env[pathName], resolveRustCargoBinDir(env)].filter(Boolean).join(delimiter) },
  });
  const built = join(cargoTargetDir, target, profile, `happier-session-holder${platform === "win32" ? ".exe" : ""}`);
  const artifact = join(artifactDir, resolveSessionHolderArtifactName(platform, arch));
  mkdirSync(artifactDir, { recursive: true });
  rmSync(artifact, { force: true });
  copyFileSync(built, artifact);
  if (platform !== "win32") chmodSync(artifact, 0o755);
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
