import { existsSync, readdirSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { RunCommand } from './commands.js';
import type { BinaryTarget } from './targets.js';

/**
 * The CLI support payload builds the Iroh lifecycle addon, the host Session
 * holder and the Linux Session target holders from current Rust sources, as it
 * builds the Go process-custody helper. It never ships whatever outputs a
 * checkout or capture happens to hold: a missing holder refuses every Agent
 * launch (`session_holder_unavailable`), and a stale one runs older code.
 */
export const IROH_NATIVE_PACKAGE_NAME = '@happier-dev/iroh-native';

type IrohNativeBuilder = Readonly<{
  buildNodeAddon(options: Readonly<{
    packageDir: string;
    artifactDir: string;
    platform: string;
    arch: string;
    runCommand: RunCommand;
  }>): Promise<string>;
  resolveArtifactName(platform: string, arch: string): string;
  resolveSessionHolderArtifactName(platform: string, arch: string): string;
  resolveSessionTargetHolderArtifactName(arch: string): string;
  SESSION_TARGET_HOLDER_RUST_TARGETS: Readonly<Record<string, string>>;
}>;

function builderPath(packageDir: string): string {
  return join(packageDir, 'scripts', 'build-node-addon.mjs');
}

/** Everything the addon and holder builds read, for the support identity (never `rust/target`). */
export function readIrohNativeRuntimeInputPaths(packageDir: string): string[] {
  const rustDir = join(packageDir, 'rust');
  const crates = readdirSync(rustDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'target')
    .map((entry) => entry.name)
    .sort();
  return [
    builderPath(packageDir),
    join(packageDir, 'rust-toolchain.toml'),
    join(rustDir, 'Cargo.toml'),
    join(rustDir, 'Cargo.lock'),
    ...crates.flatMap((crate) => ['Cargo.toml', 'build.rs', 'src']
      .map((name) => join(rustDir, crate, name))
      .filter((path) => existsSync(path))),
  ];
}

/** Builds the target's addon and every holder into `nativeDir`, then refuses an incomplete result. */
export async function stageIrohNativeRuntime({
  packageDir,
  nativeDir,
  target,
  runCommand,
}: Readonly<{
  packageDir: string;
  nativeDir: string;
  target: BinaryTarget;
  runCommand: RunCommand;
}>): Promise<void> {
  const builder = await import(pathToFileURL(builderPath(packageDir)).href) as IrohNativeBuilder;
  const platform = target.os === 'windows' ? 'win32' : target.os;
  await rm(nativeDir, { recursive: true, force: true });
  await mkdir(nativeDir, { recursive: true });
  await builder.buildNodeAddon({ packageDir, artifactDir: nativeDir, platform, arch: target.arch, runCommand });
  const required = [
    builder.resolveArtifactName(platform, target.arch),
    builder.resolveSessionHolderArtifactName(platform, target.arch),
    ...Object.keys(builder.SESSION_TARGET_HOLDER_RUST_TARGETS).map((arch) =>
      builder.resolveSessionTargetHolderArtifactName(arch)),
  ];
  const missing = required.filter((name) => !existsSync(join(nativeDir, name)));
  if (missing.length) {
    throw new Error(`[component-artifacts] Iroh native build produced no ${missing.join(', ')} in ${nativeDir}`);
  }
}
