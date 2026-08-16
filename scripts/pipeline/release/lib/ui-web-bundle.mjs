// @ts-check

import { chmod, copyFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  createDeterministicArchive,
  ensureCleanDir,
  ensureFileExists,
  maybeSignFile,
  writeChecksumsFile,
} from './binary-release.mjs';
import { precompressUiWebAssets } from './precompress-ui-web-assets.mjs';

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
  const info = await stat(distDir).catch(() => null);
  if (!info?.isDirectory()) {
    throw new Error(`[release] ui web dist directory is missing: ${distDir}`);
  }

  const indexPath = join(distDir, 'index.html');
  await ensureFileExists(indexPath);
  const indexHtml = await readFile(indexPath, 'utf8');
  const manifestHref = readLocalLinkHref(indexHtml, 'manifest');
  const appleTouchIconHref = readLocalLinkHref(indexHtml, 'apple-touch-icon');
  const manifestPath = resolveRootAssetPath(distDir, manifestHref, 'manifest');
  const manifest = await readJsonFile(manifestPath, 'PWA manifest');

  if (typeof manifest.name !== 'string' || !manifest.name.trim()) {
    throw new Error('[release] ui web PWA manifest requires a name');
  }
  if (typeof manifest.short_name !== 'string' || !manifest.short_name.trim()) {
    throw new Error('[release] ui web PWA manifest requires a short_name');
  }
  if (manifest.start_url !== '/' || manifest.scope !== '/') {
    throw new Error('[release] ui web PWA manifest must own the root start_url and scope');
  }
  if (manifest.display !== 'standalone') {
    throw new Error('[release] ui web PWA manifest must use standalone display mode');
  }

  const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
  const requiredIcons = [
    ['192x192', 'any'],
    ['512x512', 'any'],
    ['512x512', 'maskable'],
  ];
  for (const [sizes, purpose] of requiredIcons) {
    const icon = icons.find((candidate) => (
      candidate?.sizes === sizes
      && candidate?.type === 'image/png'
      && String(candidate?.purpose ?? 'any').split(/\s+/).includes(purpose)
    ));
    if (!icon || typeof icon.src !== 'string') {
      throw new Error(`[release] ui web PWA manifest requires a ${sizes} ${purpose} PNG icon`);
    }
    await ensureFileExists(resolveRootAssetPath(distDir, icon.src, `${sizes} ${purpose} icon`));
  }

  await ensureFileExists(resolveRootAssetPath(distDir, appleTouchIconHref, 'apple touch icon'));
}

function readLocalLinkHref(indexHtml, rel) {
  const escapedRel = rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const link = indexHtml.match(new RegExp(`<link\\s+[^>]*rel=["']${escapedRel}["'][^>]*>`, 'i'))?.[0];
  const href = link?.match(/\bhref=["']([^"']+)["']/i)?.[1];
  if (!href) {
    throw new Error(`[release] ui web index.html requires a ${rel} link`);
  }
  return href;
}

function resolveRootAssetPath(distDir, href, label) {
  if (!/^\/[a-zA-Z0-9._/-]+$/.test(href) || href.includes('/../')) {
    throw new Error(`[release] ui web ${label} must use a root-local asset path`);
  }
  return join(distDir, href.slice(1));
}

async function readJsonFile(path, label) {
  await ensureFileExists(path);
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`[release] ui web ${label} is not valid JSON`, { cause: error });
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
    await precompressUiWebAssets({ dir: bundleRootPath });

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
