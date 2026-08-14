import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

function collectTargetStrings(value, targets) {
  if (typeof value === 'string') {
    targets.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const nested of value) collectTargetStrings(nested, targets);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const nested of Object.values(value)) collectTargetStrings(nested, targets);
}

export function collectPackageBuildOutputTargets(packageJson) {
  const targets = [];
  for (const key of ['main', 'module', 'types']) {
    const value = packageJson?.[key];
    if (typeof value === 'string' && value.trim()) targets.push(value.trim());
  }
  collectTargetStrings(packageJson?.exports ?? {}, targets);
  return [...new Set(targets.map((target) => String(target).trim()).filter(Boolean))];
}

export function isLocalPackageBuildOutputTarget(target) {
  const normalized = String(target ?? '').trim();
  return normalized.startsWith('./') || normalized.startsWith('dist/');
}

export function isPackageBuildDistOutputTarget(target) {
  const normalized = String(target ?? '').trim().replace(/^\.\//, '');
  return normalized === 'dist' || normalized.startsWith('dist/');
}

export function resolvePackageBuildOutputTargetPath({ packageDir, outputDir, target }) {
  const normalized = String(target ?? '').replace(/^\.\//, '');
  if (normalized === 'dist') return resolve(outputDir);
  if (normalized.startsWith('dist/')) {
    return join(resolve(outputDir), ...normalized.slice('dist/'.length).split('/'));
  }
  return resolve(packageDir, normalized);
}

function toPortablePath(path) {
  return String(path).split(sep).join('/');
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function packageExportPatternRegExp(pathPattern) {
  return new RegExp(
    `^${toPortablePath(pathPattern).split('*').map(escapeRegExp).join('.*')}$`,
  );
}

function wildcardSearchRoot(pathPattern) {
  const wildcardIndex = pathPattern.indexOf('*');
  const fixedPrefix = pathPattern.slice(0, wildcardIndex);
  if (fixedPrefix.endsWith(sep)) return fixedPrefix.slice(0, -1);
  return dirname(fixedPrefix);
}

function collectWildcardMatches({ pathPattern, existsSyncImpl, readdirSyncImpl }) {
  const searchRoot = wildcardSearchRoot(pathPattern);
  if (!existsSyncImpl(searchRoot)) return [];

  const pattern = packageExportPatternRegExp(pathPattern);
  const matches = [];
  const visit = (directory) => {
    for (const entry of readdirSyncImpl(directory, { withFileTypes: true })) {
      const candidate = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(candidate);
      } else if (pattern.test(toPortablePath(candidate))) {
        matches.push(candidate);
      }
    }
  };
  visit(searchRoot);
  return matches;
}

/**
 * Resolves the concrete staged files backing one package output target. A
 * wildcard must match at least one emitted file; treating it as implicitly
 * satisfied would hide a missing generated output behind the export pattern.
 */
export function resolvePackageBuildOutputTargetMatches({
  packageDir,
  outputDir,
  target,
  existsSyncImpl = existsSync,
  readdirSyncImpl = readdirSync,
}) {
  const path = resolvePackageBuildOutputTargetPath({ packageDir, outputDir, target });
  if (!String(target).includes('*')) return existsSyncImpl(path) ? [path] : [];
  return collectWildcardMatches({ pathPattern: path, existsSyncImpl, readdirSyncImpl });
}
