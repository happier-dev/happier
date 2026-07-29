import {
  existsSync as defaultExistsSync,
  readFileSync as defaultReadFileSync,
  rmSync as defaultRmSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

function readJson(path, { readFileSync = defaultReadFileSync } = {}) {
  return JSON.parse(String(readFileSync(path, 'utf8')));
}

function resolveMaybeRelativePath(baseDir, value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  return isAbsolute(raw) ? raw : resolve(baseDir, raw);
}

function normalizeProjectPath(rawProjectPath, cwd) {
  const raw = String(rawProjectPath ?? '').trim();
  if (!raw) return '';
  const resolved = isAbsolute(raw) ? raw : resolve(cwd, raw);
  return resolved.endsWith('.json') ? resolved : resolve(resolved, 'tsconfig.json');
}

export function resolveTypeScriptProjectPathFromArgs(args, { cwd = process.cwd() } = {}) {
  const values = Array.isArray(args) ? args : [];
  for (let index = 0; index < values.length; index += 1) {
    const value = String(values[index] ?? '');
    if (value === '-p' || value === '--project') {
      return normalizeProjectPath(values[index + 1], cwd);
    }
    if (value.startsWith('--project=')) {
      return normalizeProjectPath(value.slice('--project='.length), cwd);
    }
  }
  return '';
}

export function prepareTypeScriptProjectBuild({
  tsconfigPath,
  existsSync = defaultExistsSync,
  readFileSync = defaultReadFileSync,
  rmSync = defaultRmSync,
} = {}) {
  const resolvedTsconfigPath = normalizeProjectPath(tsconfigPath, process.cwd());
  if (!resolvedTsconfigPath || !existsSync(resolvedTsconfigPath)) {
    return;
  }

  let tsconfig;
  try {
    tsconfig = readJson(resolvedTsconfigPath, { readFileSync });
  } catch {
    return;
  }

  const compilerOptions = tsconfig?.compilerOptions;
  if (!compilerOptions || typeof compilerOptions !== 'object') {
    return;
  }

  const tsconfigDir = dirname(resolvedTsconfigPath);
  const outDir = resolveMaybeRelativePath(tsconfigDir, compilerOptions.outDir);
  const tsBuildInfoFile = resolveMaybeRelativePath(tsconfigDir, compilerOptions.tsBuildInfoFile);
  if (!outDir || !tsBuildInfoFile || existsSync(outDir) || !existsSync(tsBuildInfoFile)) {
    return;
  }

  rmSync(tsBuildInfoFile, { force: true });
}

export function prepareTypeScriptProjectBuildFromArgs(args, { cwd = process.cwd(), ...options } = {}) {
  const values = Array.isArray(args) ? args : [];
  if (values.includes('--noEmit')) {
    return;
  }

  const tsconfigPath = resolveTypeScriptProjectPathFromArgs(values, { cwd });
  if (!tsconfigPath) {
    return;
  }

  prepareTypeScriptProjectBuild({ tsconfigPath, ...options });
}
