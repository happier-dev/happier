'use strict';

const { createHash } = require('node:crypto');
const { existsSync, readFileSync, readdirSync, statSync, writeFileSync } = require('node:fs');
const { dirname, isAbsolute, join, relative, resolve } = require('node:path');

const CLI_DIST_BUILD_MANIFEST = '.build-manifest.json';
const CLI_DIST_BUILD_MANIFEST_TOOL_VERSION = '2';
const DEFAULT_MAX_FILES = 5_000;

function computeStringCommentSpans(source) {
  const text = String(source ?? '');
  const spans = [];
  let index = 0;

  while (index < text.length) {
    const character = text[index];
    const nextCharacter = text[index + 1];

    if (character === '/' && nextCharacter === '/') {
      const start = index;
      index += 2;
      while (index < text.length && text[index] !== '\n') index += 1;
      spans.push([start, index]);
      continue;
    }

    if (character === '/' && nextCharacter === '*') {
      const start = index;
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index = Math.min(index + 2, text.length);
      spans.push([start, index]);
      continue;
    }

    if (character === "'" || character === '"') {
      const start = index;
      index += 1;
      while (index < text.length) {
        if (text[index] === '\\') {
          index += 2;
          continue;
        }
        if (text[index] === character) {
          index += 1;
          break;
        }
        index += 1;
      }
      spans.push([start, index]);
      continue;
    }

    if (character === '`') {
      const start = index;
      index += 1;
      let braceDepth = 0;
      while (index < text.length) {
        if (text[index] === '\\') {
          index += 2;
          continue;
        }
        if (braceDepth === 0 && text[index] === '`') {
          index += 1;
          break;
        }
        if (text[index] === '$' && text[index + 1] === '{') {
          braceDepth += 1;
          index += 2;
          continue;
        }
        if (braceDepth > 0 && text[index] === '}') braceDepth -= 1;
        index += 1;
      }
      spans.push([start, index]);
      continue;
    }

    index += 1;
  }

  return spans;
}

function extractRelativeModuleSpecifiers(source) {
  const text = String(source ?? '');
  const maskedSpans = computeStringCommentSpans(text);
  const isKeywordMasked = (index) => {
    for (const [start, end] of maskedSpans) {
      if (start > index) break;
      if (index >= start && index < end) return true;
    }
    return false;
  };
  const specifiers = new Set();
  const matches = text.matchAll(
    /(?:import|export)\s+(?:[^'"`]*?\s+from\s+)?["'](\.{1,2}\/[^"'`]+)["']|import\(\s*["'](\.{1,2}\/[^"'`]+)["']\s*\)|require\(\s*["'](\.{1,2}\/[^"'`]+)["']\s*\)/g,
  );

  for (const match of matches) {
    if (isKeywordMasked(match.index ?? -1)) continue;
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier) specifiers.add(specifier);
  }

  return [...specifiers];
}

function isPathInsideDirectory(candidatePath, directoryPath) {
  const relativePath = relative(directoryPath, candidatePath);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function resolveRelativeImport(rootDir, fromFilePath, specifier) {
  const basePath = resolve(dirname(fromFilePath), specifier);
  if (!isPathInsideDirectory(basePath, rootDir)) {
    return { ok: false, reason: `outside_dist:${basePath}` };
  }

  const candidates = [
    basePath,
    `${basePath}.mjs`,
    `${basePath}.cjs`,
    `${basePath}.js`,
    join(basePath, 'index.mjs'),
    join(basePath, 'index.cjs'),
    join(basePath, 'index.js'),
  ];
  const resolvedPath = candidates.find((candidate) => existsSync(candidate));
  return resolvedPath
    ? { ok: true, path: resolvedPath }
    : { ok: false, reason: `missing_module:${basePath}` };
}

function normalizeMaxFiles(value) {
  const parsed = Number(value ?? DEFAULT_MAX_FILES);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_FILES;
}

function collectRuntimeModuleFiles(rootDir) {
  const files = [];
  const directories = [rootDir];

  while (directories.length > 0) {
    const directoryPath = directories.shift();
    let entries;
    try {
      entries = readdirSync(directoryPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        directories.push(entryPath);
        continue;
      }
      if (entry.isFile() && /\.(?:cjs|js|mjs)$/i.test(entry.name)) files.push(entryPath);
    }
  }

  return files;
}

function readCliDistClosure(entrypoint, options = {}) {
  const normalizedEntrypoint = resolve(String(entrypoint ?? ''));
  const rootDir = resolve(String(options.outputDir ?? dirname(normalizedEntrypoint)));
  const maxFiles = normalizeMaxFiles(options.maxFiles);
  const files = [];
  const missing = [];
  const seen = new Set();
  const queue = collectRuntimeModuleFiles(rootDir);

  if (!isPathInsideDirectory(normalizedEntrypoint, rootDir)) {
    return {
      ok: false,
      reason: `entrypoint_outside_dist:${normalizedEntrypoint}`,
      rootDir,
      files: [],
      missing: [],
    };
  }
  if (!queue.includes(normalizedEntrypoint)) queue.unshift(normalizedEntrypoint);

  while (queue.length > 0) {
    if (files.length >= maxFiles) {
      return {
        ok: false,
        reason: `closure_limit_exceeded:${maxFiles}`,
        rootDir,
        files: [...new Set(files)].sort(),
        missing: [...new Set(missing)].sort(),
      };
    }

    const filePath = queue.shift();
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    files.push(filePath);

    if (!existsSync(filePath)) {
      missing.push(filePath);
      continue;
    }
    if (!/\.(?:cjs|js|mjs)$/i.test(filePath)) continue;

    let source;
    try {
      source = readFileSync(filePath, 'utf8');
    } catch {
      missing.push(filePath);
      continue;
    }

    for (const specifier of extractRelativeModuleSpecifiers(source)) {
      const resolvedImport = resolveRelativeImport(rootDir, filePath, specifier);
      if (!resolvedImport.ok) {
        missing.push(resolvedImport.reason);
        continue;
      }
      if (!seen.has(resolvedImport.path)) queue.push(resolvedImport.path);
    }
  }

  const normalizedFiles = [...new Set(files)].sort();
  const normalizedMissing = [...new Set(missing)].sort();
  return {
    ok: normalizedMissing.length === 0,
    reason: normalizedMissing.length === 0 ? 'complete' : `incomplete:${normalizedMissing[0]}`,
    rootDir,
    files: normalizedFiles,
    missing: normalizedMissing,
  };
}

function fingerprintCliDistClosure(rootDir, files) {
  const hash = createHash('sha256');
  let maxMtimeMs = 0;

  for (const filePath of files) {
    const stats = statSync(filePath);
    const source = readFileSync(filePath);
    maxMtimeMs = Math.max(maxMtimeMs, Number(stats.mtimeMs) || 0);
    hash.update(relative(rootDir, filePath).replace(/\\/g, '/'));
    hash.update('\0');
    hash.update(String(Number(stats.size) || 0));
    hash.update('\0');
    hash.update(source);
    hash.update('\0');
  }

  return {
    fingerprint: hash.digest('hex').slice(0, 16),
    maxMtimeMs: maxMtimeMs > 0 ? maxMtimeMs : null,
  };
}

function readCliDistClosureFingerprint(entrypoint, options = {}) {
  const normalizedEntrypoint = String(entrypoint ?? '').trim();
  if (!normalizedEntrypoint || !existsSync(normalizedEntrypoint)) {
    return {
      ok: false,
      reason: 'missing_entrypoint',
      fingerprint: null,
      maxMtimeMs: null,
      fileCount: 0,
    };
  }

  const closure = readCliDistClosure(normalizedEntrypoint, options);
  if (!closure.ok) {
    return {
      ok: false,
      reason: closure.reason,
      fingerprint: null,
      maxMtimeMs: null,
      fileCount: closure.files.length,
      missing: closure.missing,
    };
  }

  const fingerprint = fingerprintCliDistClosure(closure.rootDir, closure.files);
  return {
    ok: true,
    reason: 'closure',
    fingerprint: fingerprint.fingerprint,
    maxMtimeMs: fingerprint.maxMtimeMs,
    fileCount: closure.files.length,
    files: closure.files,
  };
}

function validateCliDistEntrypoint(entrypoint) {
  const normalizedEntrypoint = String(entrypoint ?? '').trim();
  if (!normalizedEntrypoint || !existsSync(normalizedEntrypoint)) {
    return { ok: false, reason: 'missing_entrypoint' };
  }

  try {
    const source = readFileSync(normalizedEntrypoint, 'utf8');
    if (source.trim().length === 0) {
      return { ok: false, reason: 'empty_entrypoint' };
    }
  } catch {
    return { ok: false, reason: 'unreadable_entrypoint' };
  }

  return { ok: true, reason: 'entrypoint' };
}

function buildCliDistManifest(entrypoint, options = {}) {
  const entrypointValidity = validateCliDistEntrypoint(entrypoint);
  if (!entrypointValidity.ok) {
    throw new Error(`[cli-dist-manifest] ${entrypointValidity.reason}: ${entrypoint}`);
  }
  const closure = readCliDistClosureFingerprint(entrypoint, options);
  if (!closure.ok) {
    throw new Error(`[cli-dist-manifest] ${closure.reason}: ${entrypoint}`);
  }
  const inputFingerprint = String(options.inputFingerprint ?? '').trim().toLowerCase();
  if (inputFingerprint && !/^[a-f0-9]{64}$/.test(inputFingerprint)) {
    throw new Error(`[cli-dist-manifest] invalid_input_fingerprint: ${entrypoint}`);
  }

  return {
    fingerprint: closure.fingerprint,
    builtAt: String(options.builtAt ?? new Date().toISOString()),
    fileCount: closure.fileCount,
    toolVersion: CLI_DIST_BUILD_MANIFEST_TOOL_VERSION,
    ...(inputFingerprint ? { inputFingerprint } : {}),
  };
}

function writeCliDistBuildManifest(entrypoint, options = {}) {
  const manifest = buildCliDistManifest(entrypoint, options);
  const outputDir = resolve(String(options.outputDir ?? dirname(resolve(String(entrypoint ?? '')))));
  const manifestPath = join(outputDir, CLI_DIST_BUILD_MANIFEST);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { manifest, manifestPath };
}

function invalidManifestResult(reason, manifestPath, extra = {}) {
  return {
    ok: false,
    reason,
    fingerprint: null,
    maxMtimeMs: null,
    fileCount: 0,
    manifestPath,
    ...extra,
  };
}

function readCliDistBuildManifest(entrypoint, options = {}) {
  const normalizedEntrypoint = String(entrypoint ?? '').trim();
  if (!normalizedEntrypoint || !existsSync(normalizedEntrypoint)) {
    return invalidManifestResult('missing_entrypoint', null);
  }

  const outputDir = resolve(String(options.outputDir ?? dirname(resolve(normalizedEntrypoint))));
  const manifestPath = join(outputDir, CLI_DIST_BUILD_MANIFEST);
  const entrypointValidity = validateCliDistEntrypoint(normalizedEntrypoint);
  if (!entrypointValidity.ok) {
    return invalidManifestResult(entrypointValidity.reason, manifestPath);
  }
  if (!existsSync(manifestPath)) {
    return invalidManifestResult('missing_build_manifest', manifestPath);
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return invalidManifestResult('invalid_build_manifest', manifestPath);
  }

  const recordedFingerprint = String(manifest?.fingerprint ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{16}$/.test(recordedFingerprint)) {
    return invalidManifestResult('invalid_build_manifest_fingerprint', manifestPath);
  }
  if (String(manifest?.toolVersion ?? '').trim() !== CLI_DIST_BUILD_MANIFEST_TOOL_VERSION) {
    return invalidManifestResult('unsupported_build_manifest_version', manifestPath);
  }
  const recordedInputFingerprint = String(manifest?.inputFingerprint ?? '').trim().toLowerCase();
  if (recordedInputFingerprint && !/^[a-f0-9]{64}$/.test(recordedInputFingerprint)) {
    return invalidManifestResult('invalid_build_manifest_input_fingerprint', manifestPath);
  }

  const recordedFileCount = Number(manifest?.fileCount);
  if (!Number.isInteger(recordedFileCount) || recordedFileCount <= 0) {
    return invalidManifestResult('invalid_build_manifest_file_count', manifestPath);
  }

  const closure = readCliDistClosureFingerprint(normalizedEntrypoint, options);
  if (!closure.ok) {
    return invalidManifestResult(closure.reason, manifestPath, {
      fileCount: closure.fileCount,
      missing: closure.missing,
      manifest,
    });
  }
  if (closure.fileCount !== recordedFileCount) {
    return invalidManifestResult('build_manifest_file_count_mismatch', manifestPath, {
      fileCount: closure.fileCount,
      recordedFileCount,
      observedFingerprint: closure.fingerprint,
      manifest,
    });
  }
  if (closure.fingerprint !== recordedFingerprint) {
    return invalidManifestResult('build_manifest_fingerprint_mismatch', manifestPath, {
      fileCount: closure.fileCount,
      recordedFingerprint,
      observedFingerprint: closure.fingerprint,
      manifest,
    });
  }

  return {
    ok: true,
    reason: 'manifest',
    fingerprint: closure.fingerprint,
    maxMtimeMs: closure.maxMtimeMs,
    fileCount: closure.fileCount,
    manifestPath,
    manifest,
  };
}

function readRecordedCliDistBuildManifestFingerprint(distDir) {
  try {
    const manifest = JSON.parse(readFileSync(join(resolve(String(distDir ?? '')), CLI_DIST_BUILD_MANIFEST), 'utf8'));
    const fingerprint = String(manifest?.fingerprint ?? '').trim().toLowerCase();
    return /^[a-f0-9]{16}$/.test(fingerprint) ? fingerprint : null;
  } catch {
    return null;
  }
}

module.exports = {
  CLI_DIST_BUILD_MANIFEST,
  CLI_DIST_BUILD_MANIFEST_TOOL_VERSION,
  buildCliDistManifest,
  extractRelativeModuleSpecifiers,
  readCliDistBuildManifest,
  readCliDistClosure,
  readCliDistClosureFingerprint,
  readRecordedCliDistBuildManifestFingerprint,
  writeCliDistBuildManifest,
};
