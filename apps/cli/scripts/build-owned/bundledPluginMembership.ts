import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const PLUGIN_PACKAGE_PREFIX = '@happier-dev/plugins-';

export type BundledPluginMembershipMode = 'write' | 'check';

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isReservationOnlyPluginPackage(pkgJson: { happier?: unknown } | null | undefined): boolean {
  const happier = pkgJson?.happier;
  if (!isRecord(happier)) return false;
  const pluginScaffold = happier.pluginScaffold ?? happier.extensionScaffold;
  if (!isRecord(pluginScaffold)) return false;
  return pluginScaffold.shipping === 'reservation_only';
}

export function pluginPackageNameToPackageId(packageName: string): string {
  if (!packageName.startsWith(PLUGIN_PACKAGE_PREFIX)) {
    throw new Error(`Invalid bundled plugin package name: ${packageName}`);
  }
  return packageName.slice(PLUGIN_PACKAGE_PREFIX.length);
}

export function readBundledPluginPackageNames(repoRoot: string): readonly string[] {
  const pluginsRoot = resolve(repoRoot, 'packages', 'plugins');
  if (!existsSync(pluginsRoot)) return [];

  const out: string[] = [];
  for (const dirent of readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const pluginPackageId = dirent.name;
    if (pluginPackageId.startsWith('_')) continue;
    const pkgJsonPath = resolve(pluginsRoot, pluginPackageId, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;
    const pkgJson = readJson(pkgJsonPath) as { name?: unknown; happier?: unknown };
    if (isReservationOnlyPluginPackage(pkgJson)) continue;

    const manifestPath = resolve(pluginsRoot, pluginPackageId, 'src/manifest.ts');
    if (!existsSync(manifestPath)) {
      throw new Error(
        `Missing required plugin manifest for shippable plugin package ${pluginPackageId}: ${manifestPath}`,
      );
    }

    const expectedPackageName = `${PLUGIN_PACKAGE_PREFIX}${pluginPackageId}`;
    if (pkgJson.name !== expectedPackageName) {
      throw new Error(`Invalid plugin package name for ${pluginPackageId}: expected ${expectedPackageName}, got ${String(pkgJson.name)}`);
    }

    out.push(expectedPackageName);
  }

  out.sort((a, b) => a.localeCompare(b));
  return out;
}

export function normalizeBundledDependencies(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.map((v) => String(v)).map((v) => v.trim()).filter((v) => v.length > 0)
    : [];
}

export function syncBundledDependencies(params: Readonly<{
  existing: readonly string[];
  bundledPluginPackageNames: readonly string[];
}>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const append = (name: string): void => {
    if (seen.has(name)) return;
    out.push(name);
    seen.add(name);
  };

  for (const name of params.existing) {
    if (!name.startsWith(PLUGIN_PACKAGE_PREFIX) && name.startsWith('@happier-dev/')) append(name);
  }

  const pluginsSorted = [...params.bundledPluginPackageNames].sort((a, b) => a.localeCompare(b));
  for (const name of pluginsSorted) append(name);

  for (const name of params.existing) {
    if (!name.startsWith(PLUGIN_PACKAGE_PREFIX) && !name.startsWith('@happier-dev/')) append(name);
  }

  return out;
}

export function syncPluginDependencies(params: Readonly<{
  existing: Readonly<Record<string, unknown>>;
  bundledPluginPackageNames: readonly string[];
}>): Record<string, unknown> {
  const expectedPluginPackageNames = new Set(params.bundledPluginPackageNames);
  const out: Record<string, unknown> = {};

  for (const [name, version] of Object.entries(params.existing)) {
    if (name.startsWith(PLUGIN_PACKAGE_PREFIX) && !expectedPluginPackageNames.has(name)) {
      continue;
    }
    out[name] = version;
  }
  for (const name of params.bundledPluginPackageNames) {
    out[name] = '0.0.0';
  }

  return out;
}

export function syncCliBundledPluginMembership(params: Readonly<{
  rootDir: string;
  mode: BundledPluginMembershipMode;
  requireCliPackageJson?: boolean;
}>): readonly string[] {
  const bundledPluginPackageNames = readBundledPluginPackageNames(params.rootDir);
  const cliPackageJsonPath = resolve(params.rootDir, 'apps', 'cli', 'package.json');
  if (!existsSync(cliPackageJsonPath)) {
    if (params.requireCliPackageJson === true) {
      throw new Error(`Missing CLI package.json: ${cliPackageJsonPath}`);
    }
    return bundledPluginPackageNames;
  }

  const cliPackageJson = readJson(cliPackageJsonPath) as Record<string, unknown>;
  const existingBundled = normalizeBundledDependencies(cliPackageJson.bundledDependencies);
  const nextBundled = syncBundledDependencies({ existing: existingBundled, bundledPluginPackageNames });
  const existingDependencies = isRecord(cliPackageJson.dependencies)
    ? cliPackageJson.dependencies
    : {};
  const nextDependencies = syncPluginDependencies({
    existing: existingDependencies,
    bundledPluginPackageNames,
  });

  if (params.mode === 'check') {
    if (JSON.stringify(existingBundled) !== JSON.stringify(nextBundled)) {
      throw new Error('apps/cli bundledDependencies are out of sync with packages/plugins/*');
    }
    const existingPluginDependencies = Object.fromEntries(
      Object.entries(existingDependencies)
        .filter(([name]) => name.startsWith(PLUGIN_PACKAGE_PREFIX))
        .sort(([left], [right]) => left.localeCompare(right)),
    );
    const expectedPluginDependencies = Object.fromEntries(
      Object.entries(nextDependencies)
        .filter(([name]) => name.startsWith(PLUGIN_PACKAGE_PREFIX))
        .sort(([left], [right]) => left.localeCompare(right)),
    );
    if (JSON.stringify(existingPluginDependencies) !== JSON.stringify(expectedPluginDependencies)) {
      throw new Error('apps/cli dependencies are out of sync with packages/plugins/*');
    }
    return bundledPluginPackageNames;
  }

  cliPackageJson.bundledDependencies = nextBundled;
  cliPackageJson.dependencies = nextDependencies;
  writeJson(cliPackageJsonPath, cliPackageJson);
  return bundledPluginPackageNames;
}
