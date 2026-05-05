import { existsSync } from 'node:fs';
import { readdir, rm as rmPath } from 'node:fs/promises';
import { join } from 'node:path';

function isTruthyEnvValue(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

async function clearAndroidGeneratedAutolinking({ uiDir }) {
  await Promise.all([
    rmPath(join(uiDir, 'android', 'build', 'generated', 'autolinking'), {
      recursive: true,
      force: true,
    }),
    rmPath(join(uiDir, 'android', 'app', 'build', 'generated', 'autolinking'), {
      recursive: true,
      force: true,
    }),
  ]);
}

async function listNodeModulePackageDirs(nodeModulesDir) {
  let entries;
  try {
    entries = await readdir(nodeModulesDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const packageDirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith('.')) continue;

    const entryPath = join(nodeModulesDir, entry.name);
    if (!entry.name.startsWith('@')) {
      packageDirs.push(entryPath);
      continue;
    }

    let scopedEntries;
    try {
      scopedEntries = await readdir(entryPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const scopedEntry of scopedEntries) {
      if (!scopedEntry.isDirectory() && !scopedEntry.isSymbolicLink()) continue;
      if (scopedEntry.name.startsWith('.')) continue;
      packageDirs.push(join(entryPath, scopedEntry.name));
    }
  }

  return packageDirs;
}

async function clearAndroidNativeModuleBuildState({ repoRoot, uiDir }) {
  const nodeModulesDirs = [...new Set([join(repoRoot, 'node_modules'), join(uiDir, 'node_modules')])];
  const packageDirGroups = await Promise.all(
    nodeModulesDirs.map((nodeModulesDir) => listNodeModulePackageDirs(nodeModulesDir))
  );
  const removals = [];

  for (const packageDir of packageDirGroups.flat()) {
    const androidDir = join(packageDir, 'android');
    if (!existsSync(androidDir)) continue;
    removals.push(
      rmPath(join(androidDir, 'build'), { recursive: true, force: true }),
      rmPath(join(androidDir, '.cxx'), { recursive: true, force: true })
    );
  }

  await Promise.all(removals);
}

export function shouldClearAndroidNativeBuildState(env) {
  return isTruthyEnvValue(env?.HAPPIER_STACK_CLEAR_ANDROID_NATIVE_BUILD_STATE);
}

export async function clearAndroidGeneratedBuildState({ repoRoot, uiDir, includeNativeModuleBuildState }) {
  const cleanupTasks = [clearAndroidGeneratedAutolinking({ uiDir })];
  if (includeNativeModuleBuildState) {
    cleanupTasks.push(clearAndroidNativeModuleBuildState({ repoRoot, uiDir }));
  }
  await Promise.all(cleanupTasks);
}
