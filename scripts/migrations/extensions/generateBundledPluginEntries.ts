import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const EXTENSIONS_PACKAGE_PREFIX = '@happier-dev/extensions-';

type Mode = 'write' | 'check';

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  // Migration scripts run single-process; an atomic rename dance is overkill here.
  writeFileSync(path, content, 'utf8');
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
    'Usage: node --experimental-strip-types scripts/migrations/extensions/generateBundledPluginEntries.ts [--root DIR] [--mode write|check]',
    '',
    'Generates/patches bundled extension entry maps from packages/extensions/*.',
  ].join('\n'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function assertJsonSerializable(value: unknown, path: string[] = []): asserts value is JsonValue {
  if (value === null) return;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return;
  if (t === 'undefined' || t === 'bigint' || t === 'symbol' || t === 'function') {
    throw new Error(`Non-JSON value at ${path.join('.') || '<root>'}: ${t}`);
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assertJsonSerializable(value[i], [...path, String(i)]);
    }
    return;
  }
  if (!isRecord(value)) {
    throw new Error(`Non-JSON object at ${path.join('.') || '<root>'}`);
  }
  for (const [k, v] of Object.entries(value)) {
    assertJsonSerializable(v, [...path, k]);
  }
}

function deepSortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((entry) => deepSortJson(entry)) as JsonValue;
  }
  if (value === null || typeof value !== 'object') return value;

  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  const out: Record<string, JsonValue> = {};
  for (const [k, v] of entries) {
    out[k] = deepSortJson(v);
  }
  return out;
}

function renderJsonLiteral(value: JsonValue, indent = 2): string {
  return JSON.stringify(deepSortJson(value), null, indent) ?? 'null';
}

async function loadExtensionAgentDefinition(repoRoot: string, extensionId: string): Promise<JsonValue> {
  const definitionPath = resolve(repoRoot, 'packages/extensions', extensionId, 'src/agent/definition.ts');
  if (!existsSync(definitionPath)) {
    throw new Error(`Missing required agent definition at ${definitionPath}`);
  }

  const mod = await import(pathToFileURL(definitionPath).href) as { AGENT_DEFINITION?: unknown };
  if (!('AGENT_DEFINITION' in mod)) {
    throw new Error(`Expected AGENT_DEFINITION export in ${definitionPath}`);
  }

  const definition = mod.AGENT_DEFINITION;
  assertJsonSerializable(definition);

  if (!isRecord(definition) || typeof definition.id !== 'string') {
    throw new Error(`Invalid AGENT_DEFINITION in ${definitionPath} (expected object with string id)`);
  }
  if (definition.id !== extensionId) {
    throw new Error(`AGENT_DEFINITION.id mismatch for ${extensionId}: got ${definition.id}`);
  }

  return definition;
}

async function readBundledExtensionPackages(repoRoot: string): Promise<ReadonlyArray<{
  extensionId: string;
  packageName: string;
  agentDefinition: JsonValue;
}>> {
  const extensionsRoot = resolve(repoRoot, 'packages', 'extensions');
  if (!existsSync(extensionsRoot)) return [];

  const out: Array<{ extensionId: string; packageName: string; agentDefinition: JsonValue }> = [];
  for (const dirent of readdirSync(extensionsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const extensionId = dirent.name;
    if (extensionId.startsWith('_')) {
      continue;
    }
    const pkgJsonPath = resolve(extensionsRoot, extensionId, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;
    const pkgJson = readJson(pkgJsonPath) as { name?: unknown };

    const expectedPackageName = `${EXTENSIONS_PACKAGE_PREFIX}${extensionId}`;
    if (pkgJson.name !== expectedPackageName) {
      throw new Error(`Invalid extension package name for ${extensionId}: expected ${expectedPackageName}, got ${String(pkgJson.name)}`);
    }

    const agentDefinition = await loadExtensionAgentDefinition(repoRoot, extensionId);
    out.push({ extensionId, packageName: expectedPackageName, agentDefinition });
  }

  out.sort((a, b) => a.extensionId.localeCompare(b.extensionId));
  return out;
}

function renderPackageNameListTs(params: Readonly<{
  header: string;
  exportedConstName: string;
  packageNames: readonly string[];
}>): string {
  const lines: string[] = [];
  lines.push('/* eslint-disable @typescript-eslint/naming-convention */');
  lines.push('/**');
  for (const l of params.header.split('\n')) lines.push(` * ${l}`);
  lines.push(' */');
  lines.push('');
  lines.push(`export const ${params.exportedConstName}: readonly string[] = Object.freeze([`);
  for (const pkg of params.packageNames) {
    lines.push(`  ${JSON.stringify(pkg)},`);
  }
  lines.push(']);');
  lines.push('');
  return lines.join('\n');
}

function renderBundledAgentDefinitionsTs(params: Readonly<{
  agentIds: readonly string[];
  agentDefinitionsById: Readonly<Record<string, JsonValue>>;
}>): string {
  const lines: string[] = [];
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (PS-04)');
  lines.push(' *');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`');
  lines.push(' */');
  lines.push('');
  lines.push(`import type { AgentDefinition } from '../definitions/agentDefinition.js';`);
  lines.push('');
  lines.push(`export const BUNDLED_AGENT_DEFINITION_IDS: readonly string[] = Object.freeze([`);
  for (const id of params.agentIds) {
    lines.push(`  ${JSON.stringify(id)},`);
  }
  lines.push(']);');
  lines.push('');
  // Keep literal types (e.g. `core.id: "claude"`) intact. Passing the object literal directly into
  // `Object.freeze(...)` can widen nested string literals (via generic inference), which then fails
  // `AgentDefinition` assignment in strict mode.
  lines.push('const _BUNDLED_AGENT_DEFINITIONS_BY_ID = ({');
  for (const id of params.agentIds) {
    const definition = params.agentDefinitionsById[id];
    if (!definition) continue;
    lines.push(`  ${JSON.stringify(id)}: Object.freeze(${renderJsonLiteral(definition)}),`);
  }
  lines.push('}) as const satisfies Readonly<Record<string, AgentDefinition>>;');
  lines.push('');
  lines.push('export const BUNDLED_AGENT_DEFINITIONS_BY_ID = Object.freeze(_BUNDLED_AGENT_DEFINITIONS_BY_ID);');
  lines.push('');
  lines.push('// Canonical generated aggregate exports (avoid "*families*" naming).');
  lines.push('export const bundledAgentDefinitionIds = BUNDLED_AGENT_DEFINITION_IDS;');
  lines.push('export const bundledAgentDefinitions = BUNDLED_AGENT_DEFINITIONS_BY_ID;');
  lines.push('');
  return lines.join('\n');
}

function patchBundledPackageNamesConstant(params: Readonly<{
  filePath: string;
  packageNames: readonly string[];
}>): void {
  const existing = readFileSync(params.filePath, 'utf8');
  const replacement = `export const BUNDLED_FIRST_PARTY_EXTENSION_PACKAGE_NAMES: readonly string[] = Object.freeze(${JSON.stringify(params.packageNames, null, 2)});\n`;

  const next = existing.replace(
    /export const BUNDLED_FIRST_PARTY_EXTENSION_PACKAGE_NAMES:[^=]*=\s*Object\.freeze\([\s\S]*?\);\n?/,
    replacement,
  );

  if (next === existing) {
    // If the file doesn't match the expected pattern, refuse to mutate it implicitly.
    throw new Error(`Unable to patch BUNDLED_FIRST_PARTY_EXTENSION_PACKAGE_NAMES in ${params.filePath}`);
  }

  writeFileAtomic(params.filePath, next);
}

function renderBundledUiBehaviorOverridesPlaceholderTs(): string {
  return [
    '/* eslint-disable @typescript-eslint/naming-convention */',
    '/**',
    ' * GENERATED FILE CONTRACT (PS-04)',
    ' *',
    ' * Placeholder generated output for bundled agent UI behavior overrides.',
    ' *',
    ' * In the fully packetized state, this file is emitted by:',
    ' * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`',
    ' */',
    '',
    'export const BUNDLED_CANONICAL_AGENT_UI_BEHAVIOR_OVERRIDES: Readonly<Record<string, unknown>> = Object.freeze({});',
    '',
  ].join('\n');
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseCliArgs(argv);
  const extensionPackages = await readBundledExtensionPackages(options.rootDir);
  const packageNames = extensionPackages.map((entry) => entry.packageName);
  const agentIds = extensionPackages.map((entry) => entry.extensionId);
  const agentDefinitionsById = Object.fromEntries(extensionPackages.map((entry) => [entry.extensionId, entry.agentDefinition]));

  const cliOutPath = resolve(options.rootDir, 'apps/cli/src/extensions/registry/sources/generatedBundledPlugins.ts');
  const uiOutPath = resolve(options.rootDir, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts');
  const uiBehaviorOverridesOutPath = resolve(
    options.rootDir,
    'apps/ui/sources/agents/registry/generatedBundledPluginEntries.uiBehaviorOverrides.ts',
  );
  const agentsOutPath = resolve(options.rootDir, 'packages/agents/src/generated/bundledAgentDefinitions.ts');

  const cliOut = renderPackageNameListTs({
    header: [
      'GENERATED FILE CONTRACT (PS-04)',
      '',
      'Bundled first-party extension package names (lexical order).',
    ].join('\n'),
    exportedConstName: 'BUNDLED_FIRST_PARTY_EXTENSION_PACKAGE_NAMES',
    packageNames,
  });

  const agentsOut = renderBundledAgentDefinitionsTs({ agentIds, agentDefinitionsById });

  if (options.mode === 'check') {
    if (existsSync(cliOutPath) && readFileSync(cliOutPath, 'utf8') !== cliOut) {
      throw new Error(`generated output differs: ${cliOutPath}`);
    }
    if (existsSync(agentsOutPath) && readFileSync(agentsOutPath, 'utf8') !== agentsOut) {
      throw new Error(`generated output differs: ${agentsOutPath}`);
    }
    // UI output is a patch-in-place file while UI registries are still transitional.
    if (!existsSync(uiBehaviorOverridesOutPath)) {
      throw new Error(`missing generated output: ${uiBehaviorOverridesOutPath}`);
    }
    return;
  }

  writeFileAtomic(cliOutPath, cliOut);
  writeFileAtomic(agentsOutPath, agentsOut);

  if (existsSync(uiOutPath)) {
    patchBundledPackageNamesConstant({ filePath: uiOutPath, packageNames });
  }

  if (!existsSync(uiBehaviorOverridesOutPath)) {
    writeFileAtomic(uiBehaviorOverridesOutPath, renderBundledUiBehaviorOverridesPlaceholderTs());
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
