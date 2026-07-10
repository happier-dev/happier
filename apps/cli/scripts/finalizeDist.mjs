import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { atomicPromoteDirectorySync, resolveCliPackageRoot } from './syncPackageDist.mjs';

export const CLI_DIST_BUILD_MANIFEST = '.build-manifest.json';
export const CLI_DIST_BUILD_MANIFEST_TOOL_VERSION = '1';

// Spans of the source that are string-literal or comment CONTENT (not real code).
// Computed left-to-right so the returned array is sorted by start offset.
// A relative `import`/`require` specifier that only appears because its keyword sits
// inside one of these spans (e.g. a package.json `postinstall` script embedded as a
// data string in a bundled config module) is NOT a runtime import and must be ignored.
function computeStringCommentSpans(source) {
  const s = String(source ?? '');
  const n = s.length;
  const spans = [];
  let i = 0;
  while (i < n) {
    const c = s[i];
    const next = s[i + 1];
    if (c === '/' && next === '/') {
      const start = i;
      i += 2;
      while (i < n && s[i] !== '\n') i += 1;
      spans.push([start, i]);
      continue;
    }
    if (c === '/' && next === '*') {
      const start = i;
      i += 2;
      while (i < n && !(s[i] === '*' && s[i + 1] === '/')) i += 1;
      i = Math.min(i + 2, n);
      spans.push([start, i]);
      continue;
    }
    if (c === "'" || c === '"') {
      const start = i;
      i += 1;
      while (i < n) {
        if (s[i] === '\\') {
          i += 2;
          continue;
        }
        if (s[i] === c) {
          i += 1;
          break;
        }
        i += 1;
      }
      spans.push([start, i]);
      continue;
    }
    if (c === '`') {
      // Mask the whole template literal (including `${...}` expressions). esbuild hoists
      // static import/require out of template expressions, so masking cannot hide a real
      // runtime import while it does prevent false positives from embedded data strings.
      const start = i;
      i += 1;
      let braceDepth = 0;
      while (i < n) {
        if (s[i] === '\\') {
          i += 2;
          continue;
        }
        if (braceDepth === 0 && s[i] === '`') {
          i += 1;
          break;
        }
        if (s[i] === '$' && s[i + 1] === '{') {
          braceDepth += 1;
          i += 2;
          continue;
        }
        if (braceDepth > 0 && s[i] === '}') {
          braceDepth -= 1;
        }
        i += 1;
      }
      spans.push([start, i]);
      continue;
    }
    i += 1;
  }
  return spans;
}

function extractRelativeMjsImportSpecifiers(source) {
  const src = String(source ?? '');
  const maskedSpans = computeStringCommentSpans(src);
  const isKeywordMasked = (index) => {
    for (const [start, end] of maskedSpans) {
      if (start > index) break;
      if (index >= start && index < end) return true;
    }
    return false;
  };
  const specs = new Set();
  const matches = src.matchAll(
    /(?:import|export)\s+(?:[^'"`]*?\s+from\s+)?["'](\.{1,2}\/[^"'`]+)["']|import\(\s*["'](\.{1,2}\/[^"'`]+)["']\s*\)|require\(\s*["'](\.{1,2}\/[^"'`]+)["']\s*\)/g,
  );
  for (const match of matches) {
    // `match.index` is the offset of the import/export/require keyword. If that keyword
    // is inside a string/comment, this is not a real module statement — skip it.
    if (isKeywordMasked(match.index ?? -1)) continue;
    const spec = match[1] ?? match[2] ?? match[3];
    if (spec) specs.add(spec);
  }
  return [...specs];
}

function resolveRelativeImport(fromFilePath, specifier) {
  const basePath = resolve(dirname(fromFilePath), specifier);
  const candidates = [
    basePath,
    `${basePath}.mjs`,
    `${basePath}.cjs`,
    join(basePath, 'index.mjs'),
    join(basePath, 'index.cjs'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return basePath;
}

export function readCliDistClosure(entrypoint, maxFiles = 400) {
  const normalizedEntrypoint = String(entrypoint ?? '').trim();
  const missing = [];
  const reachableFiles = [];
  const seenFiles = new Set();
  const queue = normalizedEntrypoint ? [normalizedEntrypoint] : [];

  while (queue.length > 0 && reachableFiles.length < maxFiles) {
    const filePath = queue.shift();
    if (!filePath || seenFiles.has(filePath)) continue;
    seenFiles.add(filePath);
    reachableFiles.push(filePath);

    if (!/\.(?:mjs|cjs)$/.test(filePath)) continue;

    let source = '';
    try {
      source = readFileSync(filePath, 'utf-8');
    } catch {
      missing.push(filePath);
      continue;
    }

    for (const specifier of extractRelativeMjsImportSpecifiers(source)) {
      const target = resolveRelativeImport(filePath, specifier);
      if (!existsSync(target)) {
        missing.push(target);
        continue;
      }
      if (!seenFiles.has(target)) queue.push(target);
    }
  }

  return {
    files: [...new Set(reachableFiles)].sort(),
    missing: [...new Set(missing)].sort(),
  };
}

export function buildCliDistManifest(entrypoint, options = {}) {
  if (!entrypoint || !existsSync(entrypoint)) {
    throw new Error(`[finalize-dist] missing entrypoint: ${entrypoint}`);
  }
  const closure = readCliDistClosure(entrypoint, options.maxFiles);
  if (closure.missing.length > 0) {
    throw new Error(`[finalize-dist] incomplete dist import closure: ${closure.missing[0]}`);
  }

  const rootDir = dirname(resolve(entrypoint));
  const hash = createHash('sha256');
  for (const filePath of closure.files) {
    const stats = statSync(filePath);
    const source = readFileSync(filePath);
    hash.update(relative(rootDir, filePath).replace(/\\/g, '/'));
    hash.update('\0');
    hash.update(String(Number(stats.size) || 0));
    hash.update('\0');
    hash.update(source);
    hash.update('\0');
  }

  return {
    fingerprint: hash.digest('hex').slice(0, 16),
    builtAt: new Date().toISOString(),
    fileCount: closure.files.length,
    toolVersion: CLI_DIST_BUILD_MANIFEST_TOOL_VERSION,
  };
}

export function readCliDistBuildManifestFingerprint(distDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(resolve(String(distDir ?? '')), CLI_DIST_BUILD_MANIFEST), 'utf-8'));
    const fingerprint = typeof parsed?.fingerprint === 'string' ? parsed.fingerprint.trim() : '';
    return fingerprint || null;
  } catch {
    return null;
  }
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
