import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PLUGINS_PACKAGE_PREFIX = '@happier-dev/plugins-';

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

function isReservationOnlyPluginPackage(rawPackageJson) {
  return rawPackageJson?.happier?.pluginScaffold?.shipping === 'reservation_only';
}

function resolveBundledPluginPackageNames({ repoRoot, existsSyncImpl = existsSync, readdirSyncImpl = readdirSync, readFileSyncImpl = readFileSync }) {
  const pluginsRoot = resolve(repoRoot, 'packages', 'plugins');
  if (!existsSyncImpl(pluginsRoot)) return [];

  const packageNames = [];
  for (const entry of readdirSyncImpl(pluginsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pluginId = entry.name;
    // Reserve underscore-prefixed directories for scaffolding/non-shippable templates.
    if (pluginId.startsWith('_')) continue;
    const pkgJsonPath = resolve(pluginsRoot, pluginId, 'package.json');
    if (!existsSyncImpl(pkgJsonPath)) continue;
    const pkgJson = readJsonSync(pkgJsonPath, { readFileSyncImpl });
    if (isReservationOnlyPluginPackage(pkgJson)) continue;

    const manifestPath = resolve(pluginsRoot, pluginId, 'src/manifest.ts');
    if (!existsSyncImpl(manifestPath)) {
      throw new Error(
        [
          `[sync-bundled-plugin-workspaces] missing required plugin manifest for shippable plugin package`,
          `path: ${manifestPath}`,
          `package: ${PLUGINS_PACKAGE_PREFIX}${pluginId}`,
        ].join('\n'),
      );
    }

    const expectedPackageName = `${PLUGINS_PACKAGE_PREFIX}${pluginId}`;
    if (pkgJson?.name !== expectedPackageName) {
      throw new Error(
        [
          `[sync-bundled-plugin-workspaces] invalid plugin package.json name`,
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

function upsertBundledDependencies({ current, pluginPackageNames }) {
  const currentList = normalizeBundledDependencyNames(current);
  const internal = currentList.filter((name) => name.startsWith('@happier-dev/'));
  const external = currentList.filter((name) => !name.startsWith('@happier-dev/'));

  const internalSet = new Set(internal);
  for (const name of pluginPackageNames) {
    internalSet.add(name);
  }

  const existingNonPluginInternal = internal.filter((name) => !name.startsWith(PLUGINS_PACKAGE_PREFIX));
  const nextPlugins = pluginPackageNames.slice();

  return [...existingNonPluginInternal, ...nextPlugins, ...external];
}

function upsertDependencies({ current, pluginPackageNames }) {
  const depsRaw = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  const deps = {};

  for (const [name, value] of Object.entries(depsRaw)) {
    if (name.startsWith(PLUGINS_PACKAGE_PREFIX) && !pluginPackageNames.includes(name)) {
      continue;
    }
    deps[name] = value;
  }

  for (const name of pluginPackageNames) {
    deps[name] = '0.0.0';
  }

  return deps;
}

export function syncBundledPluginWorkspaces(options = {}) {
  const repoRoot = resolve(String(options.repoRoot ?? findRepoRoot(__dirname)));
  const happyCliDir = resolve(String(options.happyCliDir ?? resolve(repoRoot, 'apps', 'cli')));
  const cliPackageJsonPath = resolve(happyCliDir, 'package.json');
  const existsSyncImpl = options.existsSync ?? existsSync;
  const readFileSyncImpl = options.readFileSync ?? readFileSync;
  const writeFileSyncImpl = options.writeFileSync ?? writeFileSync;
  const readdirSyncImpl = options.readdirSync ?? readdirSync;
  const pluginsRoot = resolve(repoRoot, 'packages', 'plugins');

  if (!existsSyncImpl(cliPackageJsonPath)) {
    throw new Error(`[sync-bundled-plugin-workspaces] missing CLI package.json: ${cliPackageJsonPath}`);
  }

  if (!existsSyncImpl(pluginsRoot)) {
    return { changed: false, pluginPackageNames: [] };
  }

  const pluginPackageNames = resolveBundledPluginPackageNames({
    repoRoot,
    existsSyncImpl,
    readdirSyncImpl,
    readFileSyncImpl,
  });

  const cliRaw = readJsonSync(cliPackageJsonPath, { readFileSyncImpl });
  const nextBundledDependencies = upsertBundledDependencies({
    current: cliRaw,
    pluginPackageNames,
  });
  const nextDependencies = upsertDependencies({
    current: cliRaw?.dependencies,
    pluginPackageNames,
  });

  const next = {
    ...cliRaw,
    bundledDependencies: nextBundledDependencies,
    dependencies: nextDependencies,
  };

  const before = JSON.stringify(cliRaw);
  const after = JSON.stringify(next);
  if (before === after) {
    return { changed: false, pluginPackageNames };
  }

  writeJsonSync(cliPackageJsonPath, next, { writeFileSyncImpl });
  return { changed: true, pluginPackageNames };
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return resolve(argv1) === resolve(fileURLToPath(import.meta.url));
})();

if (invokedAsMain) {
  try {
    const res = syncBundledPluginWorkspaces();
    if (res.changed) {
      console.log(`[sync-bundled-plugin-workspaces] updated apps/cli/package.json for ${res.pluginPackageNames.length} plugin workspaces`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
