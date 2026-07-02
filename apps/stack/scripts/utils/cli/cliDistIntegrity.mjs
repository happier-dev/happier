import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
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
    const fallbackBuildEntrypoint = join(binDir, '..', 'dist', 'index.mjs');
    const candidates = [
      fallbackBuildEntrypoint,
      join(binDir, '..', 'package-dist', 'index.mjs'),
    ];
    let firstExistingCandidate = null;
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      firstExistingCandidate ??= candidate;
      if (readCliDistIntegrity(candidate).ok) return candidate;
    }
    return firstExistingCandidate ?? fallbackBuildEntrypoint;
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

function readCliDistClosure(entrypoint, maxFiles = 400) {
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
        continue;
      }
      if (!seenFiles.has(target)) {
        queue.push(target);
      }
    }
  }

  return {
    files: [...new Set(reachableFiles)].sort(),
    missing: [...new Set(missing)].sort(),
  };
}

export function findMissingCliDistModules(entrypoint, maxFiles = 400) {
  return readCliDistClosure(entrypoint, maxFiles).missing;
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
  const closure = readCliDistClosure(entrypoint, maxFiles);
  const missing = closure.missing;
  if (missing.length === 0) {
    const files = closure.files;
    const hash = createHash('sha256');
    let maxMtimeMs = 0;
    const rootDir = dirname(String(entrypoint ?? '').trim());

    for (const filePath of files) {
      const stats = statSync(filePath);
      const source = readFileSync(filePath);
      maxMtimeMs = Math.max(maxMtimeMs, Number(stats.mtimeMs) || 0);
      hash.update([
        relative(rootDir, filePath),
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
