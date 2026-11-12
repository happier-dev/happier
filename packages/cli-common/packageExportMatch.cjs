'use strict';

// One package-exports subpath matcher for repository resolvers (source runtime,
// Metro, vitest). It follows Node's PACKAGE_EXPORTS_RESOLVE key selection:
// an exact non-pattern key wins; otherwise the single-`*` pattern with the
// longest prefix, then the longest key (PATTERN_KEY_COMPARE). Condition
// selection stays with each caller; targets substitute every `*`.

function exportsSubpathMap(exports) {
  if (!exports || typeof exports !== 'object' || Array.isArray(exports)) return { '.': exports };
  return Object.keys(exports).some((key) => key.startsWith('.')) ? exports : { '.': exports };
}

/** @returns {{ declaration: unknown, replacement?: string } | null} */
function matchPackageExport(exports, subpath) {
  if (exports === undefined || exports === null) return null;
  const map = exportsSubpathMap(exports);
  if (!subpath.includes('*') && Object.hasOwn(map, subpath)) return { declaration: map[subpath] };
  let best = null;
  for (const key of Object.keys(map)) {
    const star = key.indexOf('*');
    if (star < 0 || star !== key.lastIndexOf('*')) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (!subpath.startsWith(prefix) || subpath === prefix || subpath.length < key.length
      || (suffix && !subpath.endsWith(suffix))) continue;
    if (best && (prefix.length < best.prefix || (prefix.length === best.prefix && key.length <= best.key.length))) continue;
    best = { key, prefix: prefix.length, replacement: subpath.slice(prefix.length, subpath.length - suffix.length) };
  }
  return best ? { declaration: map[best.key], replacement: best.replacement } : null;
}

function substitutePackageExportTarget(target, replacement) {
  return typeof target === 'string' && replacement !== undefined ? target.replaceAll('*', replacement) : target;
}

module.exports = { matchPackageExport, substitutePackageExportTarget };
