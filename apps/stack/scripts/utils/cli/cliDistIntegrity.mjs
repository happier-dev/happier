import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

export function isCliScriptEntrypoint(pathLike) {
  const value = String(pathLike ?? '').trim().toLowerCase();
  return value.endsWith('.mjs') || value.endsWith('.js') || value.endsWith('.cjs');
}

export function isCliDirectExecutableCommand(cliBin) {
  const bin = String(cliBin ?? '').trim();
  if (!bin) return false;
  return !isCliScriptEntrypoint(bin);
}

export function resolveCliDistEntrypointFromBin(cliBin) {
  const bin = String(cliBin ?? '').trim();
  if (!bin) return null;
  if (!isCliScriptEntrypoint(bin)) return null;
  try {
    const binDir = dirname(bin);
    const candidates = [
      join(binDir, '..', 'dist', 'index.mjs'),
      join(binDir, '..', 'package-dist', 'index.mjs'),
    ];
    let firstExistingCandidate = null;
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      firstExistingCandidate ??= candidate;
      if (readCliDistIntegrity(candidate).ok) return candidate;
    }
    return firstExistingCandidate ?? candidates[0];
  } catch {
    return null;
  }
}

function extractRelativeMjsImportSpecifiers(source) {
  const specs = new Set();
  const patterns = [
    /(?:^|[^\w$])import\s+(?:[^'"]*?\s+from\s*)?['"]([^'"]+)['"]/gm,
    /(?:^|[^\w$])export\s+[^'"]*?\s+from\s*['"]([^'"]+)['"]/gm,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/gm,
  ];
  for (const re of patterns) {
    for (const match of source.matchAll(re)) {
      const spec = String(match?.[1] ?? '').trim();
      if (!spec || !spec.startsWith('.')) continue;
      if (!spec.endsWith('.mjs')) continue;
      specs.add(spec);
    }
  }
  return [...specs];
}

function listCliDistModuleFiles(rootDir, maxFiles) {
  const files = [];
  const queue = [rootDir];
  const seenDirs = new Set();

  while (queue.length > 0 && files.length < maxFiles) {
    const currentDir = queue.shift();
    if (!currentDir || seenDirs.has(currentDir)) continue;
    seenDirs.add(currentDir);

    let entries = [];
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const candidate = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(candidate);
        continue;
      }
      if (entry.isFile() && candidate.toLowerCase().endsWith('.mjs')) {
        files.push(candidate);
        if (files.length >= maxFiles) {
          break;
        }
      }
    }
  }

  return files;
}

function listCliDistClosureFiles(entrypoint, maxFiles = 400) {
  const normalizedEntrypoint = String(entrypoint ?? '').trim();
  const rootDir = dirname(normalizedEntrypoint);
  const files = listCliDistModuleFiles(rootDir, maxFiles);
  if (normalizedEntrypoint && !files.includes(normalizedEntrypoint)) {
    files.unshift(normalizedEntrypoint);
  }
  return [...new Set(files)].sort();
}

export function findMissingCliDistModules(entrypoint, maxFiles = 400) {
  const missing = [];
  const rootDir = dirname(String(entrypoint ?? '').trim());
  const moduleFiles = listCliDistModuleFiles(rootDir, maxFiles);
  if (!moduleFiles.includes(entrypoint)) {
    moduleFiles.unshift(entrypoint);
  }

  for (const filePath of moduleFiles) {
    let source = '';
    try {
      source = readFileSync(filePath, 'utf-8');
    } catch {
      missing.push(filePath);
      continue;
    }

    const imports = extractRelativeMjsImportSpecifiers(source);
    for (const spec of imports) {
      const target = join(dirname(filePath), spec);
      if (!existsSync(target)) {
        missing.push(target);
      }
    }
  }

  return [...new Set(missing)];
}

export function readCliDistIntegrity(entrypoint) {
  return readCliDistClosureFingerprint(entrypoint);
}

export function readCliDistClosureFingerprint(entrypoint, maxFiles = 400) {
  if (!entrypoint || !existsSync(entrypoint)) {
    return {
      ok: false,
      reason: 'missing_entrypoint',
      fingerprint: null,
      maxMtimeMs: null,
      fileCount: 0,
    };
  }
  const missing = findMissingCliDistModules(entrypoint, maxFiles);
  if (missing.length === 0) {
    const files = listCliDistClosureFiles(entrypoint, maxFiles);
    const hash = createHash('sha256');
    let maxMtimeMs = 0;

    for (const filePath of files) {
      const stats = statSync(filePath);
      const source = readFileSync(filePath);
      maxMtimeMs = Math.max(maxMtimeMs, Number(stats.mtimeMs) || 0);
      hash.update([
        relative(dirname(String(entrypoint ?? '').trim()), filePath),
        String(Math.trunc(Number(stats.mtimeMs) || 0)),
        String(Number(stats.size) || 0),
      ].join(':'));
      hash.update('\n');
      hash.update(source);
      hash.update('\n');
    }

    return {
      ok: true,
      reason: 'exists',
      fingerprint: hash.digest('hex').slice(0, 16),
      maxMtimeMs: maxMtimeMs > 0 ? maxMtimeMs : null,
      fileCount: files.length,
    };
  }
  return {
    ok: false,
    reason: `incomplete:${missing[0]}`,
    fingerprint: null,
    maxMtimeMs: null,
    fileCount: 0,
  };
}
