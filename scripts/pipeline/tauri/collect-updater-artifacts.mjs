// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function listFilesRecursive(dir) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.isFile()) out.push(abs);
    }
  }
  return out;
}

/**
 * @param {string} absPath
 */
function rel(absPath) {
  return path.relative(process.cwd(), absPath) || absPath;
}

/**
 * @param {string[]} files
 * @param {(p: string) => boolean} predicate
 */
function findMatching(files, predicate) {
  return files.filter(predicate).sort((a, b) => a.localeCompare(b));
}

/**
 * @param {string} platformKey
 * @param {string[]} matches
 * @returns {string}
 */
function pickSignature(platformKey, matches) {
  if (platformKey.startsWith('windows-')) {
    const preferred = matches.find((m) => m.endsWith('.nsis.zip.sig')) || matches.find((m) => m.endsWith('.exe.zip.sig')) || matches[0];
    if (!preferred) fail(`Expected at least one Windows updater signature; found 0`);
    if (matches.length > 1) {
      console.error(`Found multiple Windows updater signatures for ${platformKey}; using preferred artifact: ${rel(preferred)}`);
      console.error('All matches:');
      for (const match of matches) console.error(`  ${rel(match)}`);
    }
    return preferred;
  }

  if (matches.length !== 1) {
    fail(`Expected exactly one updater signature for ${platformKey}; found ${matches.length}`);
  }
  return matches[0];
}

/**
 * @param {string} artifactFilename
 */
function resolveArtifactExt(artifactFilename) {
  if (artifactFilename.endsWith('.msi.zip')) return '.msi.zip';
  if (artifactFilename.endsWith('.exe.zip')) return '.exe.zip';
  if (artifactFilename.endsWith('.nsis.zip')) return '.nsis.zip';
  if (artifactFilename.endsWith('.app.tar.gz')) return '.app.tar.gz';
  if (artifactFilename.endsWith('.AppImage.tar.gz')) return '.AppImage.tar.gz';
  if (artifactFilename.endsWith('.appimage.tar.gz')) return '.appimage.tar.gz';
  if (artifactFilename.includes('.')) return `.${artifactFilename.split('.').pop()}`;
  return '';
}

function main() {
  const repoRoot = path.resolve(process.cwd());
  const { values } = parseArgs({
    options: {
      environment: { type: 'string' },
      'platform-key': { type: 'string' },
      'ui-version': { type: 'string' },
      'tauri-target': { type: 'string', default: '' },
      'ui-dir': { type: 'string', default: 'apps/ui' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const environment = String(values.environment ?? '').trim();
  if (environment !== 'preview' && environment !== 'production') {
    fail(`--environment must be 'preview' or 'production' (got: ${environment || '<empty>'})`);
  }

  const platformKey = String(values['platform-key'] ?? '').trim();
  if (!platformKey) fail('--platform-key is required');
  if (!platformKey.startsWith('windows-') && !platformKey.startsWith('darwin-') && !platformKey.startsWith('linux-')) {
    fail(`Unknown platform key: ${platformKey}`);
  }

  const uiVersion = String(values['ui-version'] ?? '').trim();
  if (!uiVersion) fail('--ui-version is required');

  const tauriTarget = String(values['tauri-target'] ?? '').trim();
  const uiDir = String(values['ui-dir'] ?? '').trim() || 'apps/ui';
  const dryRun = values['dry-run'] === true;

  const absUiDir = path.resolve(repoRoot, uiDir);
  const baseDir = path.join(absUiDir, 'src-tauri', 'target');
  const searchDir = tauriTarget ? path.join(baseDir, tauriTarget) : baseDir;

  const outDir = path.join(repoRoot, 'dist', 'tauri', 'updates', platformKey);
  const outBase =
    environment === 'preview' ? `happier-ui-desktop-preview-${platformKey}` : `happier-ui-desktop-${platformKey}-v${uiVersion}`;

  if (dryRun) {
    console.log(`[dry-run] search: ${rel(searchDir)}`);
    console.log(`[dry-run] output: ${rel(outDir)}`);
    console.log(`[dry-run] out_base: ${outBase}`);
  }

  const files = dryRun ? [] : listFilesRecursive(searchDir);
  const signatureMatches = findMatching(files, (p) => {
    const normalized = p.replaceAll(path.sep, '/');
    if (!normalized.includes('/release/bundle/')) return false;
    const lower = p.toLowerCase();

    if (platformKey.startsWith('windows-')) {
      return lower.endsWith('.msi.zip.sig') || lower.endsWith('.exe.zip.sig') || lower.endsWith('.nsis.zip.sig');
    }
    if (platformKey.startsWith('darwin-')) {
      return lower.endsWith('.app.tar.gz.sig');
    }
    return lower.endsWith('.appimage.sig') || lower.endsWith('.appimage.tar.gz.sig');
  });

  const sigPath = dryRun ? path.join(searchDir, 'DRY_RUN.sig') : pickSignature(platformKey, signatureMatches);
  const artifactPath = sigPath.endsWith('.sig') ? sigPath.slice(0, -'.sig'.length) : sigPath;

  if (!dryRun) {
    if (signatureMatches.length < 1) {
      fail(`Unable to find updater signature under: ${rel(searchDir)}/**/release/bundle`);
    }
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
      fail(`Missing updater artifact for signature: ${rel(sigPath)}`);
    }
  }

  const ext = resolveArtifactExt(path.basename(artifactPath));
  const outArtifact = path.join(outDir, `${outBase}${ext}`);
  const outSig = `${outArtifact}.sig`;

  if (dryRun) {
    console.log(`[dry-run] cp ${rel(artifactPath)} -> ${rel(outArtifact)}`);
    console.log(`[dry-run] cp ${rel(sigPath)} -> ${rel(outSig)}`);
  } else {
    fs.mkdirSync(outDir, { recursive: true });
    fs.copyFileSync(artifactPath, outArtifact);
    fs.copyFileSync(sigPath, outSig);
  }

  if (platformKey.startsWith('darwin-')) {
    if (dryRun) {
      console.log(`[dry-run] maybe copy *.dmg -> ${rel(path.join(outDir, `${outBase}.dmg`))}`);
      return;
    }
    const dmgCandidates = findMatching(files, (p) => {
      const normalized = p.replaceAll(path.sep, '/');
      return normalized.includes('/release/bundle/') && p.toLowerCase().endsWith('.dmg');
    });
    if (dmgCandidates.length > 0) {
      fs.copyFileSync(dmgCandidates[0], path.join(outDir, `${outBase}.dmg`));
    }
  }
}

main();

