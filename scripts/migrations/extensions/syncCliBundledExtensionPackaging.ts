import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const EXTENSIONS_PACKAGE_PREFIX = '@happier-dev/extensions-';

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
    'Syncs apps/cli/package.json#bundledDependencies with packages/extensions/* workspace set.',
  ].join('\n'));
}

function readBundledExtensionPackageNames(repoRoot: string): readonly string[] {
  const extensionsRoot = resolve(repoRoot, 'packages', 'extensions');
  if (!existsSync(extensionsRoot)) return [];

  const out: string[] = [];
  for (const dirent of readdirSync(extensionsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const extensionId = dirent.name;
    const pkgJsonPath = resolve(extensionsRoot, extensionId, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;
    const pkgJson = readJson(pkgJsonPath) as { name?: unknown };

    const expectedPackageName = `${EXTENSIONS_PACKAGE_PREFIX}${extensionId}`;
    if (pkgJson.name !== expectedPackageName) {
      throw new Error(`Invalid extension package name for ${extensionId}: expected ${expectedPackageName}, got ${String(pkgJson.name)}`);
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
  bundledExtensionPackageNames: readonly string[];
}>): string[] {
  const withoutOldExtensions = params.existing.filter((name) => !name.startsWith(EXTENSIONS_PACKAGE_PREFIX));
  const merged = new Set<string>(withoutOldExtensions);
  for (const pkg of params.bundledExtensionPackageNames) merged.add(pkg);

  // Keep stable order: non-extension entries stay in their existing order, then extensions sorted.
  const extensionsSorted = [...params.bundledExtensionPackageNames].slice().sort((a, b) => a.localeCompare(b));
  const nonExtensions = withoutOldExtensions.filter((name) => !name.startsWith(EXTENSIONS_PACKAGE_PREFIX));
  const nonExtensionsDeduped: string[] = [];
  const seen = new Set<string>();
  for (const name of nonExtensions) {
    if (seen.has(name)) continue;
    seen.add(name);
    nonExtensionsDeduped.push(name);
  }
  for (const ext of extensionsSorted) {
    if (!seen.has(ext)) {
      nonExtensionsDeduped.push(ext);
      seen.add(ext);
    }
  }

  // Ensure we didn't accidentally drop any non-extension entries.
  for (const name of merged) {
    if (!nonExtensionsDeduped.includes(name)) nonExtensionsDeduped.push(name);
  }

  return nonExtensionsDeduped;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseCliArgs(argv);
  const cliPackageJsonPath = resolve(options.rootDir, 'apps', 'cli', 'package.json');
  if (!existsSync(cliPackageJsonPath)) {
    throw new Error(`Missing CLI package.json: ${cliPackageJsonPath}`);
  }

  const bundledExtensionPackageNames = readBundledExtensionPackageNames(options.rootDir);
  const cliPackageJson = readJson(cliPackageJsonPath) as Record<string, unknown>;
  const existingBundled = normalizeBundledDependencies(cliPackageJson.bundledDependencies);
  const nextBundled = syncBundledDependencies({ existing: existingBundled, bundledExtensionPackageNames });

  if (options.mode === 'check') {
    if (JSON.stringify(existingBundled) !== JSON.stringify(nextBundled)) {
      throw new Error('apps/cli bundledDependencies are out of sync with packages/extensions/*');
    }
    return;
  }

  cliPackageJson.bundledDependencies = nextBundled;
  writeJson(cliPackageJsonPath, cliPackageJson);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
