'use strict';

const { createHash } = require('node:crypto');
const { existsSync, lstatSync, readFileSync, readdirSync, statSync, writeFileSync } = require('node:fs');
const { dirname, isAbsolute, join, relative, resolve } = require('node:path');

const CLI_DIST_BUILD_MANIFEST = '.build-manifest.json';
const CLI_DIST_BUILD_MANIFEST_TOOL_VERSION = '2';
const DEFAULT_MAX_FILES = 5_000;

function canStartRegularExpression(source, slashIndex) {
  let index = slashIndex - 1;
  while (index >= 0 && /\s/.test(source[index])) index -= 1;
  if (index < 0) return true;

  if ('=([{,:;!?&|+-*%^~<>'.includes(source[index])) return true;
  if (!/[A-Za-z0-9_$]/.test(source[index])) return false;

  const end = index + 1;
  while (index >= 0 && /[A-Za-z0-9_$]/.test(source[index])) index -= 1;
  const previousWord = source.slice(index + 1, end);
  return /^(?:await|case|delete|do|else|in|instanceof|new|of|return|throw|typeof|void|yield)$/.test(previousWord);
}

function readRegularExpressionEnd(source, slashIndex) {
  if (!canStartRegularExpression(source, slashIndex)) return null;

  let index = slashIndex + 1;
  let inCharacterClass = false;
  while (index < source.length) {
    if (source[index] === '\\') {
      index += 2;
      continue;
    }
    if (source[index] === '[') {
      inCharacterClass = true;
      index += 1;
      continue;
    }
    if (source[index] === ']' && inCharacterClass) {
      inCharacterClass = false;
      index += 1;
      continue;
    }
    if (source[index] === '/' && !inCharacterClass) {
      index += 1;
      while (index < source.length && /[A-Za-z]/.test(source[index])) index += 1;
      return index;
    }
    if (source[index] === '\n' || source[index] === '\r') return null;
    index += 1;
  }
  return null;
}

function* iterateStringCommentSpans(source) {
  const text = String(source ?? '');
  let index = 0;

  while (index < text.length) {
    const character = text[index];
    const nextCharacter = text[index + 1];

    if (character === '/' && nextCharacter === '/') {
      const start = index;
      index += 2;
      while (index < text.length && text[index] !== '\n') index += 1;
      yield [start, index];
      continue;
    }

    if (character === '/' && nextCharacter === '*') {
      const start = index;
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index = Math.min(index + 2, text.length);
      yield [start, index];
      continue;
    }

    if (character === '/') {
      const regularExpressionEnd = readRegularExpressionEnd(text, index);
      if (regularExpressionEnd !== null) {
        yield [index, regularExpressionEnd];
        index = regularExpressionEnd;
        continue;
      }
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
      yield [start, index];
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
      yield [start, index];
      continue;
    }

    index += 1;
  }
}

function extractModuleSpecifiers(source) {
  const text = String(source ?? '');
  const maskedSpans = iterateStringCommentSpans(text);
  let span = null;
  const isKeywordMasked = (index) => {
    // Matches arrive in source order. Keep only the next relevant span rather
    // than allocating the whole source inventory and rescanning it per import.
    while (span === null || (!span.done && span.value[1] <= index)) span = maskedSpans.next();
    return !span.done && span.value[0] <= index;
  };
  const specifiers = new Set();
  const matches = text.matchAll(
    /(?:import|export)\s+(?:[^'"`]*?\s+from\s+)?["']([^"'`]+)["']|import\s*\(\s*["']([^"'`]+)["']\s*\)|require\s*\(\s*["']([^"'`]+)["']\s*\)/g,
  );

  for (const match of matches) {
    if (isKeywordMasked(match.index ?? -1)) continue;
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier) specifiers.add(specifier);
  }

  return [...specifiers];
}

function extractRelativeModuleSpecifiers(source) {
  return extractModuleSpecifiers(source).filter(specifier => /^\.{1,2}\//.test(specifier));
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
  const workspaceRuntimeIdentity = String(
    options.workspaceRuntimeIdentity ?? '',
  ).trim().toLowerCase();
  if (workspaceRuntimeIdentity && !/^[a-f0-9]{64}$/.test(workspaceRuntimeIdentity)) {
    throw new Error(`[cli-dist-manifest] invalid_workspace_runtime_identity: ${entrypoint}`);
  }
  const workspaceRuntimePackages = options.workspaceRuntimePackages;
  if (
    workspaceRuntimePackages !== undefined
    && (
      !Array.isArray(workspaceRuntimePackages)
      || workspaceRuntimePackages.length === 0
      || new Set(workspaceRuntimePackages).size !== workspaceRuntimePackages.length
      || workspaceRuntimePackages.some(
        (packageName) => !/^@happier-dev\/[a-z0-9][a-z0-9._-]*$/.test(packageName),
      )
    )
  ) {
    throw new Error(`[cli-dist-manifest] invalid_workspace_runtime_packages: ${entrypoint}`);
  }
  if (workspaceRuntimePackages !== undefined && !workspaceRuntimeIdentity) {
    throw new Error(`[cli-dist-manifest] workspace_runtime_packages_without_identity: ${entrypoint}`);
  }

  return {
    fingerprint: closure.fingerprint,
    builtAt: String(options.builtAt ?? new Date().toISOString()),
    fileCount: closure.fileCount,
    toolVersion: CLI_DIST_BUILD_MANIFEST_TOOL_VERSION,
    ...(inputFingerprint ? { inputFingerprint } : {}),
    ...(workspaceRuntimeIdentity ? { workspaceRuntimeIdentity } : {}),
    ...(workspaceRuntimePackages ? { workspaceRuntimePackages } : {}),
    ...(options.stalePackages?.length ? { stalePackages: options.stalePackages } : {}),
  };
}

function writeCliDistBuildManifest(entrypoint, options = {}) {
  const manifest = buildCliDistManifest(entrypoint, options);
  const outputDir = resolve(String(options.outputDir ?? dirname(resolve(String(entrypoint ?? '')))));
  const manifestPath = join(outputDir, CLI_DIST_BUILD_MANIFEST);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { manifest, manifestPath };
}

function writeCliDistWorkspaceRuntimeIdentity(params = {}) {
  const entrypoint = resolve(String(params.entrypoint ?? ''));
  const manifestResult = readCliDistBuildManifest(entrypoint);
  if (!manifestResult.ok || !manifestResult.manifestPath || !manifestResult.manifest) {
    throw new Error(
      `[cli-dist-manifest] cannot record workspace runtime identity from invalid build manifest: ${manifestResult.reason}`,
    );
  }
  const workspaceRuntimeIdentity = String(
    params.workspaceRuntimeIdentity ?? '',
  ).trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(workspaceRuntimeIdentity)) {
    throw new Error('[cli-dist-manifest] invalid workspace runtime identity');
  }
  const workspaceRuntimePackages = params.workspaceRuntimePackages;
  if (
    workspaceRuntimePackages !== undefined
    && (
      !Array.isArray(workspaceRuntimePackages)
      || workspaceRuntimePackages.length === 0
      || new Set(workspaceRuntimePackages).size !== workspaceRuntimePackages.length
      || workspaceRuntimePackages.some(
        (packageName) => !/^@happier-dev\/[a-z0-9][a-z0-9._-]*$/.test(packageName),
      )
    )
  ) {
    throw new Error('[cli-dist-manifest] invalid workspace runtime packages');
  }
  const manifest = {
    ...manifestResult.manifest,
    workspaceRuntimeIdentity,
    ...(workspaceRuntimePackages !== undefined ? { workspaceRuntimePackages } : {}),
  };
  writeFileSync(
    manifestResult.manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  return {
    manifest,
    manifestPath: manifestResult.manifestPath,
    workspaceRuntimeIdentity,
  };
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
  const recordedWorkspaceRuntimeIdentity = String(
    manifest?.workspaceRuntimeIdentity ?? '',
  ).trim().toLowerCase();
  if (
    recordedWorkspaceRuntimeIdentity
    && !/^[a-f0-9]{64}$/.test(recordedWorkspaceRuntimeIdentity)
  ) {
    return invalidManifestResult('invalid_workspace_runtime_identity', manifestPath);
  }
  const recordedWorkspaceRuntimePackages = manifest?.workspaceRuntimePackages;
  if (
    recordedWorkspaceRuntimePackages !== undefined
    && (
      !recordedWorkspaceRuntimeIdentity
      || !Array.isArray(recordedWorkspaceRuntimePackages)
      || recordedWorkspaceRuntimePackages.length === 0
      || new Set(recordedWorkspaceRuntimePackages).size !== recordedWorkspaceRuntimePackages.length
      || recordedWorkspaceRuntimePackages.some(
        (packageName) => !/^@happier-dev\/[a-z0-9][a-z0-9._-]*$/.test(packageName),
      )
    )
  ) {
    return invalidManifestResult('invalid_workspace_runtime_packages', manifestPath);
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

function normalizeCliRuntimeAssetRelativePath(value) {
  const rawRelativePath = String(value ?? '');
  const relativePath = rawRelativePath.trim();
  if (
    !relativePath
    || relativePath !== rawRelativePath
    || relativePath.includes('\\')
    || relativePath.startsWith('/')
    || relativePath.includes('\0')
  ) {
    return null;
  }
  const segments = relativePath.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return null;
  }
  return relativePath;
}

function parseCliRuntimeAssetManifestEntry(manifest) {
  if (Object.prototype.hasOwnProperty.call(manifest ?? {}, 'runtimeAssets')) {
    return { ok: false, reason: 'invalid_runtime_asset_manifest_entry', entry: null };
  }
  const rawEntry = manifest?.runtimeAsset;
  if (!rawEntry) {
    return { ok: false, reason: 'missing_runtime_asset_manifest', entry: null };
  }
  if (typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
    return { ok: false, reason: 'invalid_runtime_asset_manifest_entry', entry: null };
  }
  const keys = Object.keys(rawEntry).sort();
  if (keys.join('\0') !== ['byteLength', 'relativePath', 'sha256'].join('\0')) {
    return { ok: false, reason: 'invalid_runtime_asset_manifest_entry', entry: null };
  }
  const relativePath = normalizeCliRuntimeAssetRelativePath(rawEntry.relativePath);
  const byteLength = Number(rawEntry.byteLength);
  const sha256 = String(rawEntry.sha256 ?? '').trim().toLowerCase();
  if (
    !relativePath
    || !Number.isSafeInteger(byteLength)
    || byteLength < 0
    || !/^[a-f0-9]{64}$/.test(sha256)
  ) {
    return { ok: false, reason: 'invalid_runtime_asset_manifest_entry', entry: null };
  }
  return {
    ok: true,
    reason: 'runtime_asset_manifest',
    entry: { relativePath, byteLength, sha256 },
  };
}

// A single asset keeps the predecessor format; multiple independently consumed
// native assets share this same owner rather than overwriting one another.
function parseCliRuntimeAssetManifestEntries(manifest) {
  const hasSingle = Object.prototype.hasOwnProperty.call(manifest ?? {}, 'runtimeAsset');
  const hasMultiple = Object.prototype.hasOwnProperty.call(manifest ?? {}, 'runtimeAssets');
  if (!hasMultiple) {
    const parsed = parseCliRuntimeAssetManifestEntry(manifest);
    return { ...parsed, entries: parsed.ok ? [parsed.entry] : [] };
  }
  const rawEntries = manifest.runtimeAssets;
  if (hasSingle || !Array.isArray(rawEntries) || rawEntries.length < 2) {
    return { ok: false, reason: 'invalid_runtime_asset_manifest_entry', entries: [] };
  }
  const entries = [];
  const paths = new Set();
  for (const raw of rawEntries) {
    const parsed = parseCliRuntimeAssetManifestEntry({ runtimeAsset: raw });
    if (!parsed.ok || paths.has(parsed.entry.relativePath)) {
      return { ok: false, reason: 'invalid_runtime_asset_manifest_entry', entries: [] };
    }
    entries.push(parsed.entry);
    paths.add(parsed.entry.relativePath);
  }
  return { ok: true, reason: 'runtime_asset_manifest', entries };
}

function resolveCliRuntimeAssetPath(runtimeRoot, relativePath) {
  const normalizedRoot = resolve(String(runtimeRoot ?? ''));
  const normalizedRelativePath = normalizeCliRuntimeAssetRelativePath(relativePath);
  if (!normalizedRelativePath) return null;
  const assetPath = resolve(normalizedRoot, ...normalizedRelativePath.split('/'));
  return isPathInsideDirectory(assetPath, normalizedRoot) && assetPath !== normalizedRoot
    ? assetPath
    : null;
}

function writeCliRuntimeAssetBuildManifest(params = {}) {
  const runtimeRoot = resolve(String(params.runtimeRoot ?? ''));
  const entrypoint = resolve(String(params.entrypoint ?? ''));
  const manifestResult = readCliDistBuildManifest(entrypoint);
  if (!manifestResult.ok || !manifestResult.manifestPath || !manifestResult.manifest) {
    throw new Error(
      `[cli-dist-manifest] cannot record runtime assets from invalid build manifest: ${manifestResult.reason}`,
    );
  }
  const relativePath = normalizeCliRuntimeAssetRelativePath(params.relativePath);
  if (!relativePath) {
    throw new Error('[cli-dist-manifest] expected exactly one canonical runtime asset path');
  }
  const assetPath = resolveCliRuntimeAssetPath(runtimeRoot, relativePath);
  if (!assetPath) {
    throw new Error(`[cli-dist-manifest] invalid runtime asset path: ${relativePath}`);
  }
  const assetEntry = lstatSync(assetPath);
  if (assetEntry.isSymbolicLink() || !assetEntry.isFile()) {
    throw new Error(`[cli-dist-manifest] runtime asset must be a physical file: ${relativePath}`);
  }
  const bytes = readFileSync(assetPath);
  const runtimeAsset = {
    relativePath,
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const previous = parseCliRuntimeAssetManifestEntries(manifestResult.manifest);
  if (!previous.ok && previous.reason !== 'missing_runtime_asset_manifest') {
    throw new Error(`[cli-dist-manifest] cannot extend invalid runtime asset manifest: ${previous.reason}`);
  }
  const entries = [...previous.entries.filter((entry) => entry.relativePath !== relativePath), runtimeAsset];
  const { runtimeAsset: _previousAsset, runtimeAssets: _previousAssets, ...previousManifest } = manifestResult.manifest;
  const manifest = {
    ...previousManifest,
    ...(entries.length === 1 ? { runtimeAsset } : { runtimeAssets: entries }),
  };
  writeFileSync(
    manifestResult.manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  return {
    manifest,
    manifestPath: manifestResult.manifestPath,
    runtimeAsset,
  };
}

function refreshCliRuntimeAssetBuildManifest(params = {}) {
  const runtimeRoot = resolve(String(params.runtimeRoot ?? ''));
  const entrypoint = resolve(String(params.entrypoint ?? ''));
  const manifestResult = readCliDistBuildManifest(entrypoint);
  if (!manifestResult.ok || !manifestResult.manifest) {
    throw new Error(
      `[cli-dist-manifest] cannot refresh runtime asset from invalid build manifest: ${manifestResult.reason}`,
    );
  }
  const parsed = parseCliRuntimeAssetManifestEntries(manifestResult.manifest);
  if (!parsed.ok) {
    throw new Error(
      `[cli-dist-manifest] cannot refresh runtime asset from invalid manifest entry: ${parsed.reason}`,
    );
  }
  let result;
  for (const entry of parsed.entries) {
    result = writeCliRuntimeAssetBuildManifest({ runtimeRoot, entrypoint, relativePath: entry.relativePath });
  }
  return result;
}

function readCliRuntimeAssetIntegrity(params = {}) {
  const runtimeRoot = resolve(String(params.runtimeRoot ?? ''));
  const relativePath = normalizeCliRuntimeAssetRelativePath(params.relativePath);
  if (!relativePath) {
    return { ok: false, reason: 'invalid_runtime_asset_path', relativePath: null };
  }
  const assetPath = resolveCliRuntimeAssetPath(runtimeRoot, relativePath);
  if (!assetPath) {
    return { ok: false, reason: 'invalid_runtime_asset_path', relativePath };
  }
  const entrypoint = params.entrypoint
    ? resolve(String(params.entrypoint))
    : join(runtimeRoot, 'package-dist', 'index.mjs');
  if (!isPathInsideDirectory(entrypoint, runtimeRoot) || entrypoint === runtimeRoot) {
    return {
      ok: false,
      reason: 'invalid_runtime_asset_entrypoint',
      relativePath,
      assetPath,
      manifestPath: null,
    };
  }
  const manifestResult = readCliDistBuildManifest(entrypoint);
  if (!manifestResult.ok || !manifestResult.manifest) {
    return {
      ok: false,
      reason: manifestResult.reason,
      relativePath,
      assetPath,
      manifestPath: manifestResult.manifestPath,
    };
  }
  const parsed = parseCliRuntimeAssetManifestEntries(manifestResult.manifest);
  if (!parsed.ok) {
    return {
      ok: false,
      reason: parsed.reason,
      relativePath,
      assetPath,
      manifestPath: manifestResult.manifestPath,
    };
  }
  const expected = parsed.entries.find((entry) => entry.relativePath === relativePath);
  if (!expected) {
    return {
      ok: false,
      reason: 'runtime_asset_not_recorded',
      relativePath,
      assetPath,
      manifestPath: manifestResult.manifestPath,
    };
  }

  try {
    const entry = lstatSync(assetPath);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      return {
        ok: false,
        reason: 'runtime_asset_not_physical_file',
        relativePath,
        assetPath,
        manifestPath: manifestResult.manifestPath,
      };
    }
    if (entry.size !== expected.byteLength) {
      return {
        ok: false,
        reason: 'runtime_asset_byte_length_mismatch',
        relativePath,
        assetPath,
        manifestPath: manifestResult.manifestPath,
        expected,
      };
    }
    const observedSha256 = createHash('sha256')
      .update(readFileSync(assetPath))
      .digest('hex');
    if (observedSha256 !== expected.sha256) {
      return {
        ok: false,
        reason: 'runtime_asset_sha256_mismatch',
        relativePath,
        assetPath,
        manifestPath: manifestResult.manifestPath,
        expected,
        observedSha256,
      };
    }
    return {
      ok: true,
      reason: 'runtime_asset_manifest',
      relativePath,
      assetPath,
      manifestPath: manifestResult.manifestPath,
      expected,
      observedSha256,
    };
  } catch {
    return {
      ok: false,
      reason: 'runtime_asset_unreadable',
      relativePath,
      assetPath,
      manifestPath: manifestResult.manifestPath,
      expected,
    };
  }
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
  extractModuleSpecifiers,
  extractRelativeModuleSpecifiers,
  readCliDistBuildManifest,
  readCliDistClosure,
  readCliDistClosureFingerprint,
  readCliRuntimeAssetIntegrity,
  readRecordedCliDistBuildManifestFingerprint,
  refreshCliRuntimeAssetBuildManifest,
  writeCliDistWorkspaceRuntimeIdentity,
  writeCliRuntimeAssetBuildManifest,
  writeCliDistBuildManifest,
};
