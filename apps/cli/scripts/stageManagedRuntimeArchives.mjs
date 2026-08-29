#!/usr/bin/env node

/**
 * Stage the CLIProxyAPI managed-runtime wrapper into the npm CLI publication.
 *
 * The npm CLI tarball ships `tools/archives` and extracts the current platform's
 * archives during postinstall. The managed CLIProxyAPI Provider declares its
 * launch path as `tools/unpacked/happier-cliproxyapi-managed[.exe]`, so without
 * a staged archive an npm install advertises managed CLIProxyAPI and then fails
 * at launch. This script is the publication-side producer for those archives.
 *
 * It does not build or license anything itself: it drives the one existing
 * component-artifact staging owner, which owns the pinned Go build and the
 * license/third-party-notice bytes for every distribution shape.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { createRequire } from 'node:module';

import * as tar from 'tar';

import {
  CLI_BINARY_TARGETS,
  execOrThrow,
  resolveYarnCommand,
  stageCliProxyApiManagedRuntime,
  stageProcessCustodyRuntime,
} from '@happier-dev/cli-common/componentArtifacts';

const require = createRequire(import.meta.url);
const {
  getCliRuntimeAssetArchiveManifest,
  RUNTIME_ASSET_CHECKSUM_MANIFEST_NAME,
} = require('./unpack-tools.cjs');

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PACKAGE_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(CLI_PACKAGE_ROOT, '..', '..');

/**
 * Platform-directory names are the postinstall owner's vocabulary; binary
 * targets are the component-artifact owner's. This is the one translation.
 */
function resolveBinaryTargetForPlatformDir(platformDir) {
  const [arch, platform] = platformDir.split('-');
  const os = platform === 'win32' ? 'windows' : platform;
  const target = CLI_BINARY_TARGETS.find(
    (candidate) => candidate.os === os && candidate.arch === arch,
  );
  if (!target) {
    throw new Error(`[stage-managed-runtime] no CLI binary target for platform directory: ${platformDir}`);
  }
  return target;
}

async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

/**
 * Runtime-asset checksums live in their own generated inventory beside the
 * committed tool inventory, so staging never rewrites a tracked file and the
 * release worktree stays clean. Staging is additive per platform, so lines for
 * platforms staged by an earlier invocation are preserved byte-for-byte.
 */
async function updateChecksumManifest(archivesDir, stagedChecksums) {
  const manifestPath = join(archivesDir, RUNTIME_ASSET_CHECKSUM_MANIFEST_NAME);
  const existing = existsSync(manifestPath) ? await readFile(manifestPath, 'utf8') : '';
  const retained = existing
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      const match = trimmed.match(/^[a-fA-F0-9]{64}\s+\*?(.+)$/);
      return !match || !stagedChecksums.has(match[1].trim());
    });
  const staged = [...stagedChecksums.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([archiveName, checksum]) => `${checksum}  ${archiveName}`);
  await writeFile(manifestPath, `${[...retained, ...staged].join('\n')}\n`, 'utf8');
  return manifestPath;
}

export async function stageManagedRuntimeArchives({
  archivesDir = join(CLI_PACKAGE_ROOT, 'tools', 'archives'),
  platformDirs,
  repoRoot = REPO_ROOT,
  runCommand = execOrThrow,
  yarn = resolveYarnCommand({}),
  stageManagedRuntime = stageCliProxyApiManagedRuntime,
  stageProcessCustody = stageProcessCustodyRuntime,
} = {}) {
  const manifest = getCliRuntimeAssetArchiveManifest();
  const selected = platformDirs && platformDirs.length > 0
    ? manifest.filter((entry) => platformDirs.includes(entry.platformDir))
    : manifest;
  if (selected.length === 0) {
    throw new Error('[stage-managed-runtime] no runtime asset archives selected');
  }

  await mkdir(archivesDir, { recursive: true });
  const stagingRoot = await mkdtemp(join(tmpdir(), 'happier-managed-runtime-stage-'));
  const staged = [];
  try {
    for (const entry of selected) {
      const target = resolveBinaryTargetForPlatformDir(entry.platformDir);
      const payloadDir = join(stagingRoot, entry.platformDir);
      await stageManagedRuntime({ repoRoot, payloadDir, target, yarn, runCommand });
      await stageProcessCustody({ repoRoot, payloadDir, target, runCommand });

      const sourceDir = join(payloadDir, 'tools', 'unpacked');
      const contents = (await readdir(sourceDir)).sort();
      const expected = [
        entry.binaryName,
        ...(entry.extraBinaries ?? []),
        ...entry.licenseNames,
      ].sort();
      for (const name of expected) {
        if (!contents.includes(name)) {
          throw new Error(`[stage-managed-runtime] staged payload is missing ${name} for ${entry.platformDir}`);
        }
      }

      const archivePath = join(archivesDir, entry.archiveName);
      await rm(archivePath, { force: true });
      await tar.create({ cwd: sourceDir, file: archivePath, gzip: true, portable: true }, expected);
      staged.push({ entry, archivePath, checksum: await sha256File(archivePath) });
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }

  const manifestPath = await updateChecksumManifest(
    archivesDir,
    new Map(staged.map(({ entry, checksum }) => [entry.archiveName, checksum])),
  );
  return {
    archivesDir,
    checksumManifestPath: manifestPath,
    archives: staged.map(({ entry, archivePath, checksum }) => ({
      platformDir: entry.platformDir,
      archiveName: entry.archiveName,
      archivePath,
      checksum,
    })),
  };
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  return Boolean(argv1) && resolve(argv1) === resolve(fileURLToPath(import.meta.url));
})();

if (invokedAsMain) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'archives-dir': { type: 'string' },
      platform: { type: 'string', multiple: true },
    },
    strict: true,
  });
  try {
    const result = await stageManagedRuntimeArchives({
      ...(values['archives-dir'] ? { archivesDir: resolve(values['archives-dir']) } : {}),
      ...(values.platform ? { platformDirs: values.platform } : {}),
    });
    for (const archive of result.archives) {
      console.log(`${archive.checksum}  ${archive.archiveName}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
