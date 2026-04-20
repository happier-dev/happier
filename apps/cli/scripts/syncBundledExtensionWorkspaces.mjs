import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const EXTENSIONS_PACKAGE_PREFIX = '@happier-dev/extensions-';

function findRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, 'package.json')) && existsSync(resolve(dir, 'yarn.lock'))) {
      return dir;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(startDir, '..', '..', '..');
}

function readJsonSync(path, { readFileSyncImpl = readFileSync } = {}) {
  return JSON.parse(readFileSyncImpl(path, 'utf8'));
}

function writeJsonSync(path, value, { writeFileSyncImpl = writeFileSync } = {}) {
  writeFileSyncImpl(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function resolveBundledExtensionPackageNames({ repoRoot, existsSyncImpl = existsSync, readdirSyncImpl = readdirSync, readFileSyncImpl = readFileSync }) {
  const extensionsRoot = resolve(repoRoot, 'packages', 'extensions');
  if (!existsSyncImpl(extensionsRoot)) return [];

  const packageNames = [];
  for (const entry of readdirSyncImpl(extensionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const extensionId = entry.name;
    // Reserve underscore-prefixed directories for scaffolding/non-shippable templates.
    if (extensionId.startsWith('_')) continue;
    const pkgJsonPath = resolve(extensionsRoot, extensionId, 'package.json');
    if (!existsSyncImpl(pkgJsonPath)) continue;

    const expectedPackageName = `${EXTENSIONS_PACKAGE_PREFIX}${extensionId}`;
    const pkgJson = readJsonSync(pkgJsonPath, { readFileSyncImpl });
    if (pkgJson?.name !== expectedPackageName) {
      throw new Error(
        [
          `[sync-bundled-extension-workspaces] invalid extension package.json name`,
          `path: ${pkgJsonPath}`,
          `expected: ${expectedPackageName}`,
          `actual: ${String(pkgJson?.name ?? '')}`,
        ].join('\n'),
      );
    }
    packageNames.push(expectedPackageName);
  }

  packageNames.sort((a, b) => a.localeCompare(b));
  return packageNames;
}

function normalizeBundledDependencyNames(raw) {
  const bundledDependencies = Array.isArray(raw?.bundledDependencies)
    ? raw.bundledDependencies
    : Array.isArray(raw?.bundleDependencies)
      ? raw.bundleDependencies
      : [];

  return bundledDependencies
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value) => value.length > 0);
}

function upsertBundledDependencies({ current, extensionPackageNames }) {
  const currentList = normalizeBundledDependencyNames(current);
  const internal = currentList.filter((name) => name.startsWith('@happier-dev/'));
  const external = currentList.filter((name) => !name.startsWith('@happier-dev/'));

  const internalSet = new Set(internal);
  for (const name of extensionPackageNames) {
    internalSet.add(name);
  }

  const existingNonExtensionInternal = internal.filter((name) => !name.startsWith(EXTENSIONS_PACKAGE_PREFIX));
  const nextExtensions = extensionPackageNames.slice();

  return [...existingNonExtensionInternal, ...nextExtensions, ...external];
}

function upsertDependencies({ current, extensionPackageNames }) {
  const depsRaw = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  const deps = { ...depsRaw };

  for (const name of extensionPackageNames) {
    deps[name] = '0.0.0';
  }

  return deps;
}

export function syncBundledExtensionWorkspaces(options = {}) {
  const repoRoot = resolve(String(options.repoRoot ?? findRepoRoot(__dirname)));
  const happyCliDir = resolve(String(options.happyCliDir ?? resolve(repoRoot, 'apps', 'cli')));
  const cliPackageJsonPath = resolve(happyCliDir, 'package.json');
  const existsSyncImpl = options.existsSync ?? existsSync;
  const readFileSyncImpl = options.readFileSync ?? readFileSync;
  const writeFileSyncImpl = options.writeFileSync ?? writeFileSync;
  const readdirSyncImpl = options.readdirSync ?? readdirSync;

  if (!existsSyncImpl(cliPackageJsonPath)) {
    throw new Error(`[sync-bundled-extension-workspaces] missing CLI package.json: ${cliPackageJsonPath}`);
  }

  const extensionPackageNames = resolveBundledExtensionPackageNames({
    repoRoot,
    existsSyncImpl,
    readdirSyncImpl,
    readFileSyncImpl,
  });
  if (extensionPackageNames.length === 0) {
    return { changed: false, extensionPackageNames };
  }

  const cliRaw = readJsonSync(cliPackageJsonPath, { readFileSyncImpl });
  const nextBundledDependencies = upsertBundledDependencies({
    current: cliRaw,
    extensionPackageNames,
  });
  const nextDependencies = upsertDependencies({
    current: cliRaw?.dependencies,
    extensionPackageNames,
  });

  const next = {
    ...cliRaw,
    bundledDependencies: nextBundledDependencies,
    dependencies: nextDependencies,
  };

  const before = JSON.stringify(cliRaw);
  const after = JSON.stringify(next);
  if (before === after) {
    return { changed: false, extensionPackageNames };
  }

  writeJsonSync(cliPackageJsonPath, next, { writeFileSyncImpl });
  return { changed: true, extensionPackageNames };
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return resolve(argv1) === resolve(fileURLToPath(import.meta.url));
})();

if (invokedAsMain) {
  try {
    const res = syncBundledExtensionWorkspaces();
    if (res.changed) {
      console.log(`[sync-bundled-extension-workspaces] updated apps/cli/package.json for ${res.extensionPackageNames.length} extension workspaces`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
