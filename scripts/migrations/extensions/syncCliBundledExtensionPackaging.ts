import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PLUGIN_PACKAGE_PREFIX = '@happier-dev/plugins-';

type Mode = 'write' | 'check';

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseCliArgs(argv: readonly string[]): Readonly<{ rootDir: string; mode: Mode }> {
  let rootDir = process.cwd();
  let mode: Mode = 'write';

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
    if (arg === '--root') {
      const next = argv[index + 1];
      if (!next) throw new Error('Missing value for --root');
      rootDir = next;
      index += 1;
      continue;
    }
    if (arg === '--mode') {
      const next = argv[index + 1];
      if (next !== 'write' && next !== 'check') {
        throw new Error(`Invalid --mode (expected write|check): ${String(next)}`);
      }
      mode = next;
      index += 1;
      continue;
    }
    throw new Error(`Unknown arg: ${arg}`);
  }

  return { rootDir, mode };
}

function printUsage(): void {
  console.log([
    'Usage: node --experimental-strip-types scripts/migrations/extensions/syncCliBundledExtensionPackaging.ts [--root DIR] [--mode write|check]',
    '',
    'Syncs apps/cli/package.json#bundledDependencies with packages/plugins/* workspace set.',
  ].join('\n'));
}

function isReservationOnlyPluginPackage(pkgJson: { happier?: unknown } | null | undefined): boolean {
  const happier = pkgJson?.happier;
  if (typeof happier !== 'object' || happier === null) return false;
  const pluginScaffold = (happier as { pluginScaffold?: unknown; extensionScaffold?: unknown }).pluginScaffold
    ?? (happier as { extensionScaffold?: unknown }).extensionScaffold;
  if (typeof pluginScaffold !== 'object' || pluginScaffold === null) return false;
  return (pluginScaffold as { shipping?: unknown }).shipping === 'reservation_only';
}

function readBundledPluginPackageNames(repoRoot: string): readonly string[] {
  const pluginsRoot = resolve(repoRoot, 'packages', 'plugins');
  if (!existsSync(pluginsRoot)) return [];

  const out: string[] = [];
  for (const dirent of readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const pluginPackageId = dirent.name;
    if (pluginPackageId.startsWith('_')) continue;
    const pkgJsonPath = resolve(pluginsRoot, pluginPackageId, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;
    const pkgJson = readJson(pkgJsonPath) as { name?: unknown };
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

function normalizeBundledDependencies(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.map((v) => String(v)).map((v) => v.trim()).filter((v) => v.length > 0)
    : [];
}

function syncBundledDependencies(params: Readonly<{
  existing: readonly string[];
  bundledPluginPackageNames: readonly string[];
}>): string[] {
  const withoutOldPlugins = params.existing.filter((name) => !name.startsWith(PLUGIN_PACKAGE_PREFIX));
  const merged = new Set<string>(withoutOldPlugins);
  for (const pkg of params.bundledPluginPackageNames) merged.add(pkg);

  // Keep stable order: non-plugin entries stay in their existing order, then plugin packages sorted.
  const pluginsSorted = [...params.bundledPluginPackageNames].slice().sort((a, b) => a.localeCompare(b));
  const nonPlugins = withoutOldPlugins.filter((name) => !name.startsWith(PLUGIN_PACKAGE_PREFIX));
  const nonPluginsDeduped: string[] = [];
  const seen = new Set<string>();
  for (const name of nonPlugins) {
    if (seen.has(name)) continue;
    seen.add(name);
    nonPluginsDeduped.push(name);
  }
  for (const pluginPackageName of pluginsSorted) {
    if (!seen.has(pluginPackageName)) {
      nonPluginsDeduped.push(pluginPackageName);
      seen.add(pluginPackageName);
    }
  }

  // Ensure we didn't accidentally drop any non-plugin entries.
  for (const name of merged) {
    if (!nonPluginsDeduped.includes(name)) nonPluginsDeduped.push(name);
  }

  return nonPluginsDeduped;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseCliArgs(argv);
  const cliPackageJsonPath = resolve(options.rootDir, 'apps', 'cli', 'package.json');
  if (!existsSync(cliPackageJsonPath)) {
    throw new Error(`Missing CLI package.json: ${cliPackageJsonPath}`);
  }

  const bundledPluginPackageNames = readBundledPluginPackageNames(options.rootDir);
  const cliPackageJson = readJson(cliPackageJsonPath) as Record<string, unknown>;
  const existingBundled = normalizeBundledDependencies(cliPackageJson.bundledDependencies);
  const nextBundled = syncBundledDependencies({ existing: existingBundled, bundledPluginPackageNames });

  if (options.mode === 'check') {
    if (JSON.stringify(existingBundled) !== JSON.stringify(nextBundled)) {
      throw new Error('apps/cli bundledDependencies are out of sync with packages/plugins/*');
    }
    return;
  }

  cliPackageJson.bundledDependencies = nextBundled;
  writeJson(cliPackageJsonPath, cliPackageJson);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
