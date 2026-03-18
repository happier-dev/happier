import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function normalizePath(raw) {
  const value = String(raw ?? '').trim();
  return value ? resolve(value) : '';
}

function sanitizeBundledWorkspacePackageJson(raw) {
  const {
    name,
    version,
    type,
    main,
    module,
    types,
    exports,
    dependencies,
    peerDependencies,
    optionalDependencies,
    engines,
  } = raw ?? {};

  return {
    name,
    version,
    private: true,
    type,
    main,
    module,
    types,
    exports,
    dependencies,
    peerDependencies,
    optionalDependencies,
    engines,
  };
}

async function listBundledWorkspacePackageNames(targetPackageRoot) {
  const scopeDir = resolve(targetPackageRoot, 'node_modules', '@happier-dev');
  const entries = await readdir(scopeDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function normalizePackageNames(packageNames) {
  return [...new Set((packageNames ?? []).map((value) => String(value ?? '').trim()).filter(Boolean))].sort();
}

export async function syncBundledWorkspacePackages({ repoRoot, targetPackageRoot, packageNames } = {}) {
  const resolvedRepoRoot = normalizePath(repoRoot);
  const resolvedTargetPackageRoot = normalizePath(targetPackageRoot);
  if (!resolvedRepoRoot || !resolvedTargetPackageRoot) {
    throw new Error('syncBundledWorkspacePackages requires repoRoot and targetPackageRoot');
  }

  const names =
    Array.isArray(packageNames) && packageNames.length > 0
      ? normalizePackageNames(packageNames)
      : await listBundledWorkspacePackageNames(resolvedTargetPackageRoot);
  const updatedPackages = [];

  for (const packageName of names) {
    const workspaceDir = resolve(resolvedRepoRoot, 'packages', packageName);
    const srcPackageJsonPath = resolve(workspaceDir, 'package.json');
    const srcDistDir = resolve(workspaceDir, 'dist');
    const destPackageDir = resolve(resolvedTargetPackageRoot, 'node_modules', '@happier-dev', packageName);

    const [rawPackageJson, srcDistExists] = await Promise.all([
      readFile(srcPackageJsonPath, 'utf-8').catch(() => ''),
      readdir(srcDistDir).then(() => true).catch(() => false),
    ]);
    if (!rawPackageJson || !srcDistExists) {
      continue;
    }

    let parsedPackageJson;
    try {
      parsedPackageJson = JSON.parse(rawPackageJson);
    } catch {
      continue;
    }
    if (parsedPackageJson?.name !== `@happier-dev/${packageName}`) {
      continue;
    }

    await mkdir(destPackageDir, { recursive: true });
    await rm(resolve(destPackageDir, 'dist'), { recursive: true, force: true });
    await cp(srcDistDir, resolve(destPackageDir, 'dist'), { recursive: true, force: true });
    await writeFile(
      resolve(destPackageDir, 'package.json'),
      `${JSON.stringify(sanitizeBundledWorkspacePackageJson(parsedPackageJson), null, 2)}\n`,
      'utf-8',
    );
    updatedPackages.push(packageName);
  }

  return {
    repoRoot: resolvedRepoRoot,
    targetPackageRoot: resolvedTargetPackageRoot,
    updatedPackages,
  };
}

function readFlagValue(argv, name) {
  const prefix = `${name}=`;
  const direct = argv.find((value) => String(value).startsWith(prefix));
  if (direct) {
    return String(direct).slice(prefix.length);
  }
  const index = argv.indexOf(name);
  return index >= 0 ? String(argv[index + 1] ?? '').trim() : '';
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  return Boolean(argv1 && resolve(argv1) === import.meta.filename);
})();

if (invokedAsMain) {
  syncBundledWorkspacePackages({
    repoRoot: readFlagValue(process.argv.slice(2), '--repo-root'),
    targetPackageRoot: readFlagValue(process.argv.slice(2), '--target-package-root'),
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
