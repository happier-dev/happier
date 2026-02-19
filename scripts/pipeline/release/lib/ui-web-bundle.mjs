// @ts-check

import { chmod, copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  createDeterministicArchive,
  ensureCleanDir,
  ensureFileExists,
  maybeSignFile,
  writeChecksumsFile,
} from './binary-release.mjs';

export const UI_WEB_PRODUCT = 'happier-ui-web';
export const UI_WEB_TARGET = Object.freeze({ os: 'web', arch: 'any' });

async function copyDirContents(sourceDir, destDir) {
  await mkdir(destDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = join(sourceDir, entry.name);
    const destPath = join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirContents(sourcePath, destPath);
      continue;
    }
    if (entry.isFile()) {
      await mkdir(dirname(destPath), { recursive: true });
      await copyFile(sourcePath, destPath);
      await chmod(destPath, 0o644).catch(() => {});
    }
  }
}

async function assertUiWebDistValid(distDir) {
  await ensureFileExists(join(distDir, 'index.html'));
  const info = await stat(distDir).catch(() => null);
  if (!info?.isDirectory()) {
    throw new Error(`[release] ui web dist directory is missing: ${distDir}`);
  }
}

export async function createUiWebReleaseArtifacts({ version, distDir, outDir }) {
  const v = String(version ?? '').trim();
  if (!v) throw new Error('[release] ui web bundle requires a version');
  const source = String(distDir ?? '').trim();
  const dest = String(outDir ?? '').trim();
  if (!source) throw new Error('[release] ui web bundle requires distDir');
  if (!dest) throw new Error('[release] ui web bundle requires outDir');

  await assertUiWebDistValid(source);
  await ensureCleanDir(dest);

  const artifactStem = `${UI_WEB_PRODUCT}-v${v}-${UI_WEB_TARGET.os}-${UI_WEB_TARGET.arch}`;
  const stageRoot = join(dest, '.tmp-ui-web-stage');
  await ensureCleanDir(stageRoot);

  const archiveName = `${artifactStem}.tar.gz`;
  const archivePath = join(dest, archiveName);
  const bundleRootName = artifactStem;
  try {
    const bundleRootPath = join(stageRoot, bundleRootName);
    await ensureCleanDir(bundleRootPath);
    await copyDirContents(source, bundleRootPath);

    await createDeterministicArchive({
      artifactPath: archivePath,
      sourcePath: stageRoot,
      sourceName: bundleRootName,
    });
  } finally {
    await rm(stageRoot, { recursive: true, force: true });
  }

  const artifacts = [
    {
      name: archiveName,
      path: archivePath,
      os: UI_WEB_TARGET.os,
      arch: UI_WEB_TARGET.arch,
    },
  ];

  const checksumsPath = await writeChecksumsFile({
    product: UI_WEB_PRODUCT,
    version: v,
    artifacts,
    outDir: dest,
  });
  const signaturePath = await maybeSignFile({
    path: checksumsPath,
    trustedComment: `${UI_WEB_PRODUCT} ${v}`,
  });

  return {
    product: UI_WEB_PRODUCT,
    version: v,
    outDir: dest,
    artifacts,
    checksums: checksumsPath,
    signature: signaturePath,
  };
}
