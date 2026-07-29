import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import cliDistBuildManifest from '@happier-dev/cli-common/cliDistBuildManifest';

import { atomicPromoteDirectorySync, resolveCliPackageRoot } from './syncPackageDist.mjs';

export const CLI_DIST_BUILD_MANIFEST = cliDistBuildManifest.CLI_DIST_BUILD_MANIFEST;
export const CLI_DIST_BUILD_MANIFEST_TOOL_VERSION = cliDistBuildManifest.CLI_DIST_BUILD_MANIFEST_TOOL_VERSION;
export const readCliDistBuildManifest = cliDistBuildManifest.readCliDistBuildManifest;
export const readCliDistClosure = cliDistBuildManifest.readCliDistClosure;
export const buildCliDistManifest = cliDistBuildManifest.buildCliDistManifest;

export function readCliDistBuildManifestFingerprint(distDir) {
  return cliDistBuildManifest.readRecordedCliDistBuildManifestFingerprint(distDir);
}

export function finalizeDist(options = {}) {
  const packageRoot = resolve(String(options.packageRoot ?? resolveCliPackageRoot()));
  const stagingDir = resolve(String(options.stagingDir ?? join(packageRoot, process.env.HAPPIER_CLI_BUILD_OUTPUT_DIR ?? 'dist.staging')));
  const distDir = resolve(String(options.distDir ?? join(packageRoot, 'dist')));
  const entrypoint = join(stagingDir, 'index.mjs');
  const manifest = buildCliDistManifest(entrypoint, options);
  writeFileSync(join(stagingDir, CLI_DIST_BUILD_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  if (Object.prototype.hasOwnProperty.call(options, 'expectedCurrentFingerprint')) {
    const expected = options.expectedCurrentFingerprint ?? null;
    const current = readCliDistBuildManifestFingerprint(distDir);
    if (current !== expected) {
      throw new Error(
        `[finalize-dist] dist changed while this build was running (expected ${expected ?? 'none'}, found ${current ?? 'none'}); refusing to promote stale output.`,
      );
    }
  }

  const suffix = `${process.pid}.${Date.now()}`;
  atomicPromoteDirectorySync({
    sourceDir: stagingDir,
    targetDir: distDir,
    backupDir: `${distDir}.__finalize_backup__.${suffix}`,
    removeSourceOnFailure: false,
  });

  return { packageRoot, stagingDir, distDir, manifest };
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return resolve(argv1) === resolve(fileURLToPath(import.meta.url));
})();

if (invokedAsMain) {
  try {
    finalizeDist({ stagingDir: process.argv[2] });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
