import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
    return join(binDir, '..', 'dist', 'index.mjs');
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

export function findMissingCliDistModules(entrypoint, maxFiles = 400) {
  const missing = [];
  const seen = new Set();
  const queue = [entrypoint];
  while (queue.length > 0 && seen.size < maxFiles) {
    const filePath = queue.shift();
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);

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
      if (!seen.has(target)) {
        queue.push(target);
      }
    }
  }
  return missing;
}

export function readCliDistIntegrity(entrypoint) {
  if (!entrypoint || !existsSync(entrypoint)) {
    return { ok: false, reason: 'missing_entrypoint' };
  }
  const missing = findMissingCliDistModules(entrypoint);
  if (missing.length === 0) {
    return { ok: true, reason: 'exists' };
  }
  return { ok: false, reason: `incomplete:${missing[0]}` };
}
