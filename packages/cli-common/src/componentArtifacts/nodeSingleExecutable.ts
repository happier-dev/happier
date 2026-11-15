import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execOrThrow, type RunCommand } from './commands.js';
import type { BinaryTarget } from './targets.js';

/**
 * The shipped `happier` executable is an official Node.js release binary with the
 * Happier entry injected as a single-executable application. The Node version is the
 * repository's `.node-version` (the same runtime CI and development use); this table
 * holds the SHA-256 of each official release asset the build consumes for that version.
 * Bumping `.node-version` without adding its digests fails the build.
 */
const NODE_RELEASE_ASSET_SHA256: Readonly<Record<string, string>> = {
  'v24.22.1/node-v24.22.1-linux-x64.tar.gz': 'eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c',
  'v24.22.1/node-v24.22.1-linux-arm64.tar.gz': '33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3',
  'v24.22.1/node-v24.22.1-darwin-x64.tar.gz': 'd132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035',
  'v24.22.1/node-v24.22.1-darwin-arm64.tar.gz': '89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7',
  'v24.22.1/win-x64/node.exe': 'd702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5',
};

const NODE_RELEASE_BASE_URL = 'https://nodejs.org/download/release';
// Node 24 looks for this fuse to decide whether an injected blob exists.
const NODE_SEA_SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

/**
 * Embedded main of the single executable. It accepts exactly the two forms Happier
 * launches, both with Node semantics:
 *   happier [--no-warnings] [--no-deprecation] <absolute .js|.cjs|.mjs> ...args
 *     runs that script (CLI children, hook forwarders, relays). The two flags are the
 *     executable's own `execArgv`, so they are already in effect.
 *   happier ...args
 *     runs the Happier CLI from `package-dist/` beside the executable.
 */
export const NODE_SINGLE_EXECUTABLE_MAIN = `'use strict';
const { existsSync } = require('node:fs');
const { dirname, isAbsolute, join } = require('node:path');
const argv = process.argv;
let index = 2;
while (argv[index] === '--no-warnings' || argv[index] === '--no-deprecation') index += 1;
const script = argv[index];
if (script !== undefined && isAbsolute(script) && /\\.[cm]?js$/u.test(script) && existsSync(script)) {
  argv.splice(1, index - 1);
} else {
  argv[1] = join(dirname(process.execPath), 'package-dist', 'index.mjs');
}
require('node:module').runMain();
`;

export type NodeReleaseAsset = Readonly<{
  version: string;
  /** Path below the release root, e.g. `v24.22.1/node-v24.22.1-linux-x64.tar.gz`. */
  path: string;
  sha256: string;
  /** Archive member holding the binary, or null when the asset is the binary itself. */
  archiveMember: string | null;
}>;

export function readPinnedNodeVersion(repoRoot: string): string {
  const raw = readFileSync(join(repoRoot, '.node-version'), 'utf8').trim().replace(/^v/u, '');
  if (!/^\d+\.\d+\.\d+$/u.test(raw)) {
    throw new Error(`[component-artifacts] .node-version must name an exact Node release, found "${raw}"`);
  }
  return raw;
}

export function resolveNodeReleaseAsset({ version, target }: { version: string; target: BinaryTarget }): NodeReleaseAsset {
  const platform = target.os === 'windows' ? 'win' : target.os;
  if (!['linux', 'darwin', 'win'].includes(platform) || !['x64', 'arm64'].includes(target.arch)) {
    throw new Error(`[component-artifacts] no Node release for ${target.os}-${target.arch}`);
  }
  const path = platform === 'win'
    ? `v${version}/${platform}-${target.arch}/node.exe`
    : `v${version}/node-v${version}-${platform}-${target.arch}.tar.gz`;
  const sha256 = NODE_RELEASE_ASSET_SHA256[path];
  if (!sha256) {
    throw new Error(
      `[component-artifacts] no pinned SHA-256 for Node release asset ${path}; add it from the release's SHASUMS256.txt`,
    );
  }
  return {
    version,
    path,
    sha256,
    archiveMember: platform === 'win' ? null : `node-v${version}-${platform}-${target.arch}/bin/node`,
  };
}

// Build-tool cache in this checkout, shared by every build and test that runs the tool.
const NODE_RUNTIME_CACHE_DIR = fileURLToPath(new URL('../../../../node_modules/.cache/happier-node-runtime/', import.meta.url));

/**
 * Official Node binary for `target` at the `.node-version` of `repoRoot`, verified against
 * its pinned digest and cached by digest so repeated builds download it once.
 */
export async function ensurePinnedNodeBinary({
  repoRoot,
  target,
  fetchImpl = globalThis.fetch,
  cacheRoot = NODE_RUNTIME_CACHE_DIR,
}: {
  repoRoot: string;
  target: BinaryTarget;
  fetchImpl?: typeof fetch;
  cacheRoot?: string;
}): Promise<string> {
  const asset = resolveNodeReleaseAsset({ version: readPinnedNodeVersion(repoRoot), target });
  const cacheDir = join(cacheRoot, asset.sha256);
  const binaryPath = join(cacheDir, target.os === 'windows' ? 'node.exe' : 'node');
  if (existsSync(binaryPath)) return binaryPath;

  const response = await fetchImpl(`${NODE_RELEASE_BASE_URL}/${asset.path}`);
  if (!response.ok) {
    throw new Error(`[component-artifacts] failed to download Node release asset ${asset.path} (${response.status})`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== asset.sha256) {
    throw new Error(`[component-artifacts] Node release asset ${asset.path} has SHA-256 ${digest}, expected ${asset.sha256}`);
  }

  await mkdir(dirname(cacheDir), { recursive: true });
  const stagingDir = await mkdtemp(`${cacheDir}.staging-`);
  try {
    const stagedBinary = join(stagingDir, target.os === 'windows' ? 'node.exe' : 'node');
    if (asset.archiveMember) {
      const archivePath = join(stagingDir, 'release.tar.gz');
      await writeFile(archivePath, bytes);
      const tar = await import('tar');
      await tar.x({ file: archivePath, cwd: stagingDir, filter: (entry) => entry === asset.archiveMember });
      await rename(join(stagingDir, asset.archiveMember), stagedBinary);
      await rm(archivePath, { force: true });
      await rm(join(stagingDir, asset.archiveMember.split('/')[0]!), { recursive: true, force: true });
    } else {
      await writeFile(stagedBinary, bytes);
    }
    await chmod(stagedBinary, 0o755);
    await rename(stagingDir, cacheDir).catch(async (error: NodeJS.ErrnoException) => {
      // A concurrent build published the same verified digest first.
      if (!existsSync(binaryPath)) throw error;
    });
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
  return binaryPath;
}

/**
 * Build the `happier` single executable for `target` (the build host's own platform):
 * the pinned Node binary plus the embedded main above. macOS output is ad-hoc signed so
 * it runs locally; release signing replaces that signature with the Developer ID one.
 */
export async function compileNodeSingleExecutable({
  repoRoot,
  target,
  outfile,
  runCommand = execOrThrow,
  ensureNodeBinary = ensurePinnedNodeBinary,
}: {
  repoRoot: string;
  target: BinaryTarget;
  outfile: string;
  runCommand?: RunCommand;
  ensureNodeBinary?: typeof ensurePinnedNodeBinary;
}): Promise<void> {
  const nodeBinary = await ensureNodeBinary({ repoRoot, target });
  const { inject } = createRequire(import.meta.url)('postject') as {
    inject: (file: string, name: string, data: Buffer, options: Readonly<Record<string, string>>) => Promise<void>;
  };
  const workDir = await mkdtemp(join(dirname(outfile), '.node-sea-'));
  try {
    const mainPath = join(workDir, 'main.cjs');
    const blobPath = join(workDir, 'sea.blob');
    const configPath = join(workDir, 'sea-config.json');
    await writeFile(mainPath, NODE_SINGLE_EXECUTABLE_MAIN);
    await writeFile(configPath, JSON.stringify({
      main: mainPath,
      output: blobPath,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
      execArgv: ['--no-warnings', '--no-deprecation'],
    }));
    await runCommand(nodeBinary, ['--experimental-sea-config', configPath], { cwd: workDir });

    await rm(outfile, { force: true });
    await copyFile(nodeBinary, outfile);
    await chmod(outfile, 0o755);
    if (target.os === 'linux') await runCommand('strip', [outfile]);
    if (target.os === 'darwin') await runCommand('codesign', ['--remove-signature', outfile]);
    await inject(outfile, 'NODE_SEA_BLOB', await readFile(blobPath), {
      sentinelFuse: NODE_SEA_SENTINEL_FUSE,
      ...(target.os === 'darwin' ? { machoSegmentName: 'NODE_SEA' } : {}),
    });
    if (target.os === 'darwin') await runCommand('codesign', ['--sign', '-', '--force', outfile]);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
