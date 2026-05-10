import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  getAllBackendDefinitions,
  getAllBackendDefinitionContracts,
  getAllProviderDefinitionContracts,
  getProviderDefinition,
  getProviderCliRuntimeSpec,
} from '@happier-dev/agents';
import { PluginManifestV2Schema } from '@happier-dev/protocol';

type TsImport = (specifier: string, parentURL: string) => Promise<unknown>;

const PLUGIN_PACKAGE_PREFIX = '@happier-dev/plugins-';

type Mode = 'write' | 'check';

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = Readonly<{ [key: string]: JsonValue }>;
type PluginManifestJson = JsonObject & Readonly<{ id: string }>;
type BundledPluginPackage = Readonly<{
  pluginPackageId: string;
  pluginId: string;
  packageName: string;
  packageVersion: string;
  manifest: PluginManifestJson;
  agentId?: string;
  agentDefinition?: JsonValue;
}>;
type AgentBundledPluginPackage = BundledPluginPackage & Readonly<{
  agentId: string;
  agentDefinition: JsonValue;
}>;

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
    'Generates/patches bundled plugin entry maps from packages/plugins/*.',
  ].join('\n'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isReservationOnlyPluginPackage(pkgJson: { happier?: unknown } | null | undefined): boolean {
  const happier = pkgJson?.happier;
  if (!isRecord(happier)) return false;
  const pluginScaffold = happier.pluginScaffold ?? happier.extensionScaffold;
  if (!isRecord(pluginScaffold)) return false;
  return pluginScaffold.shipping === 'reservation_only';
}

function readBundledPluginPackageAllowlist(repoRoot: string): ReadonlySet<string> | null {
  const cliPackageJsonPath = resolve(repoRoot, 'apps/cli/package.json');
  if (!existsSync(cliPackageJsonPath)) return null;
  const pkgJson = readJson(cliPackageJsonPath) as { bundledDependencies?: unknown };
  if (!Array.isArray(pkgJson.bundledDependencies)) return null;
  return new Set(pkgJson.bundledDependencies.filter((entry): entry is string => typeof entry === 'string'));
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

async function importTypescriptModule(path: string): Promise<unknown> {
  const { tsImport } = await import('tsx/esm/api') as Readonly<{ tsImport: TsImport }>;
  const mod = await tsImport(path, import.meta.url);
  if (isRecord(mod) && isRecord(mod.default)) {
    return mod.default;
  }
  return mod;
}

function readManifestContributionArray(manifest: PluginManifestJson, family: string): readonly JsonValue[] {
  const contributes = manifest.contributes;
  if (!isRecord(contributes)) return [];
  const value = contributes[family];
  return Array.isArray(value) ? value : [];
}

function readRequiredContributionId(value: JsonValue, family: string, pluginPackageId: string): string {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.trim().length === 0) {
    throw new Error(`Invalid ${family} contribution in ${pluginPackageId}: expected object with non-empty string id`);
  }
  return value.id;
}

async function loadPluginAgentDefinition(repoRoot: string, pluginPackageId: string): Promise<JsonValue> {
  const definitionPath = resolve(repoRoot, 'packages/plugins', pluginPackageId, 'src/agent/definition.ts');
  if (!existsSync(definitionPath)) {
    throw new Error(`Missing required agent definition at ${definitionPath}`);
  }

  const mod = await importTypescriptModule(definitionPath) as { AGENT_DEFINITION?: unknown };
  if (!('AGENT_DEFINITION' in mod)) {
    throw new Error(`Expected AGENT_DEFINITION export in ${definitionPath}`);
  }

  const definition = mod.AGENT_DEFINITION;
  assertJsonSerializable(definition);

  if (!isRecord(definition) || typeof definition.id !== 'string') {
    throw new Error(`Invalid AGENT_DEFINITION in ${definitionPath} (expected object with string id)`);
  }

  return definition;
}

async function loadPluginManifest(repoRoot: string, pluginPackageId: string): Promise<PluginManifestJson> {
  const manifestPath = resolve(repoRoot, 'packages/plugins', pluginPackageId, 'src/manifest.ts');
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing required plugin manifest for shippable plugin package ${pluginPackageId}: ${manifestPath}`);
  }

  const mod = await importTypescriptModule(manifestPath) as { PLUGIN_MANIFEST?: unknown };
  if (!('PLUGIN_MANIFEST' in mod)) {
    throw new Error(`Expected PLUGIN_MANIFEST export in ${manifestPath}`);
  }

  const manifest = JSON.parse(JSON.stringify(mod.PLUGIN_MANIFEST)) as unknown;
  assertJsonSerializable(manifest);
  if (!isRecord(manifest) || typeof manifest.id !== 'string' || !manifest.id.startsWith('happier.')) {
    throw new Error(
      `Invalid PLUGIN_MANIFEST in ${manifestPath}: bundled plugins must use a canonical first-party plugin owner id under happier.*`,
    );
  }

  const parsed = PluginManifestV2Schema.safeParse(manifest);
  if (!parsed.success) {
    throw new Error(`Invalid PLUGIN_MANIFEST in ${manifestPath}: ${parsed.error.message}`);
  }

  return parsed.data as PluginManifestJson;
}

function manifestDeclaresAgentRuntime(manifest: JsonValue): boolean {
  if (!isRecord(manifest)) return false;

  const runtime = manifest.runtime;
  if (isRecord(runtime) && Array.isArray(runtime.capabilities)) {
    if (runtime.capabilities.some((capability) => capability === 'agents' || capability === 'backends')) {
      return true;
    }
  }

  const contributes = manifest.contributes;
  if (!isRecord(contributes)) return false;
  return ['agents', 'backends'].some((family) => Array.isArray(contributes[family]) && contributes[family].length > 0);
}

async function readBundledPluginPackages(repoRoot: string): Promise<readonly BundledPluginPackage[]> {
  const pluginsRoot = resolve(repoRoot, 'packages', 'plugins');
  if (!existsSync(pluginsRoot)) return [];
  const packageNameAllowlist = readBundledPluginPackageAllowlist(repoRoot);

  const out: BundledPluginPackage[] = [];
  for (const dirent of readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const pluginPackageId = dirent.name;
    if (pluginPackageId.startsWith('_')) {
      continue;
    }
    const pkgJsonPath = resolve(pluginsRoot, pluginPackageId, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;
    const pkgJson = readJson(pkgJsonPath) as { name?: unknown; version?: unknown };
    if (isReservationOnlyPluginPackage(pkgJson)) {
      continue;
    }

    const expectedPackageName = `${PLUGIN_PACKAGE_PREFIX}${pluginPackageId}`;
    if (packageNameAllowlist && !packageNameAllowlist.has(expectedPackageName)) {
      continue;
    }
    if (pkgJson.name !== expectedPackageName) {
      throw new Error(`Invalid plugin package name for ${pluginPackageId}: expected ${expectedPackageName}, got ${String(pkgJson.name)}`);
    }
    if (typeof pkgJson.version !== 'string' || pkgJson.version.trim().length === 0) {
      throw new Error(`Invalid plugin package version for ${pluginPackageId}: expected non-empty string`);
    }

    const manifest = await loadPluginManifest(repoRoot, pluginPackageId);
    const definitionPath = resolve(pluginsRoot, pluginPackageId, 'src/agent/definition.ts');
    const agentDefinition = existsSync(definitionPath)
      ? await loadPluginAgentDefinition(repoRoot, pluginPackageId)
      : undefined;
    if (!agentDefinition && manifestDeclaresAgentRuntime(manifest)) {
      throw new Error(
        `Missing required agent definition for agent-capable plugin package ${pluginPackageId}: ${definitionPath}`,
      );
    }

    out.push({
      pluginPackageId,
      pluginId: manifest.id,
      packageName: expectedPackageName,
      packageVersion: pkgJson.version,
      manifest,
      ...(agentDefinition ? { agentId: agentDefinition.id, agentDefinition } : {}),
    });
  }

  out.sort((a, b) => a.packageName.localeCompare(b.packageName));
  return out;
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
    lines.push(`  ${JSON.stringify(id)}: Object.freeze((${renderJsonLiteral(definition)}) as const),`);
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

function renderCliBundledPluginEntriesTs(params: Readonly<{
  pluginPackages: readonly BundledPluginPackage[];
}>): string {
  const metadata = params.pluginPackages.map((entry) => ({
    ...(entry.agentId ? { agentId: entry.agentId } : {}),
    manifestDigest: `bundled:${entry.packageName}@${entry.packageVersion}`,
    manifestPath: `bundled:${entry.pluginId}`,
    packageName: entry.packageName,
    packageVersion: entry.packageVersion,
    pluginId: entry.pluginId,
    pluginPackageId: entry.pluginPackageId,
  }));
  const metadataByPluginPackageId = new Map(metadata.map((entry) => [entry.pluginPackageId, entry] as const));
  const scmHostingProviderContributions = params.pluginPackages.flatMap((entry) => (
    readManifestContributionArray(entry.manifest, 'scmHostingProviders').map((definition) => {
      const contributionId = readRequiredContributionId(definition, 'scmHostingProviders', entry.pluginPackageId);
      const contributionMetadata = metadataByPluginPackageId.get(entry.pluginPackageId);
      if (!contributionMetadata) {
        throw new Error(`Missing bundled plugin metadata for ${entry.pluginPackageId}`);
      }
      return {
        id: contributionId,
        definition,
        metadata: contributionMetadata,
      };
    })
  ));
  const connectedAccountDescriptorContributions = params.pluginPackages.flatMap((entry) => (
    readManifestContributionArray(entry.manifest, 'connectedAccountDescriptors').map((definition) => {
      const contributionId = readRequiredContributionId(definition, 'connectedAccountDescriptors', entry.pluginPackageId);
      const contributionMetadata = metadataByPluginPackageId.get(entry.pluginPackageId);
      if (!contributionMetadata) {
        throw new Error(`Missing bundled plugin metadata for ${entry.pluginPackageId}`);
      }
      return {
        id: contributionId,
        definition,
        metadata: contributionMetadata,
      };
    })
  ));
  const installableContributions = params.pluginPackages.flatMap((entry) => (
    readManifestContributionArray(entry.manifest, 'installables').map((definition) => {
      const contributionId = readRequiredContributionId(definition, 'installables', entry.pluginPackageId);
      const contributionMetadata = metadataByPluginPackageId.get(entry.pluginPackageId);
      if (!contributionMetadata) {
        throw new Error(`Missing bundled plugin metadata for ${entry.pluginPackageId}`);
      }
      return {
        id: contributionId,
        definition,
        metadata: contributionMetadata,
      };
    })
  ));
  const scmBackendContributions = params.pluginPackages.flatMap((entry) => (
    readManifestContributionArray(entry.manifest, 'scmBackends').map((definition) => {
      const contributionId = readRequiredContributionId(definition, 'scmBackends', entry.pluginPackageId);
      const contributionMetadata = metadataByPluginPackageId.get(entry.pluginPackageId);
      if (!contributionMetadata) {
        throw new Error(`Missing bundled plugin metadata for ${entry.pluginPackageId}`);
      }
      return {
        id: contributionId,
        definition,
        metadata: contributionMetadata,
      };
    })
  ));

  const lines: string[] = [];
  lines.push('/* eslint-disable @typescript-eslint/naming-convention */');
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (PS-04)');
  lines.push(' *');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`');
  lines.push(' *');
  lines.push(' * Runtime reads this local artifact; executable plugin packages are only named as locators.');
  lines.push(' */');
  lines.push('');
  lines.push('import {');
  lines.push('  getAllBackendDefinitions,');
  lines.push('  getAllBackendDefinitionContracts,');
  lines.push('  getAllProviderDefinitionContracts,');
  lines.push('  getProviderDefinition,');
  lines.push('  getProviderCliRuntimeSpec,');
  lines.push('  isAgentId,');
  lines.push('} from \'@happier-dev/agents\';');
  lines.push('import type { AgentId } from \'@happier-dev/agents\';');
  lines.push('');
  lines.push('import type {');
  lines.push('  ResolvedActivationTarget,');
  lines.push('  ResolvedBackendContribution,');
  lines.push('  ResolvedCatalogEntry,');
  lines.push('  ResolvedConnectedAccountDescriptorContribution,');
  lines.push('  ResolvedInstallableContribution,');
  lines.push('  ResolvedProviderContribution,');
  lines.push('  ResolvedScmBackendContribution,');
  lines.push('  ResolvedScmHostingProviderContribution,');
  lines.push('} from \'../types\';');
  lines.push('');
  lines.push('export type BundledFirstPartyPluginMetadata = Readonly<{');
  lines.push('  agentId?: string;');
  lines.push('  pluginId: string;');
  lines.push('  pluginPackageId: string;');
  lines.push('  packageName: string;');
  lines.push('  packageVersion: string;');
  lines.push('  manifestPath: string;');
  lines.push('  manifestDigest: string;');
  lines.push('}>;');
  lines.push('');
  lines.push('type BundledContributionMetadataFields = Pick<');
  lines.push('  ResolvedActivationTarget,');
  lines.push('  \'pluginId\' | \'manifestPath\' | \'manifestDigest\' | \'daemonEntryPath\' | \'sourceSpec\'');
  lines.push('>;');
  lines.push('');
  lines.push('export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES: readonly string[] = Object.freeze([');
  for (const entry of params.pluginPackages) {
    lines.push(`  ${JSON.stringify(entry.packageName)},`);
  }
  lines.push(']);');
  lines.push('');
  lines.push('export const BUNDLED_FIRST_PARTY_PLUGIN_METADATA: readonly BundledFirstPartyPluginMetadata[] = Object.freeze(');
  lines.push(`${renderJsonLiteral(metadata)});`);
  lines.push('');
  lines.push('const bundledPluginMetadataByAgentId = new Map(');
  lines.push('  BUNDLED_FIRST_PARTY_PLUGIN_METADATA');
  lines.push('    .filter((entry): entry is BundledFirstPartyPluginMetadata & Readonly<{ agentId: string }> => typeof entry.agentId === \'string\')');
  lines.push('    .map((entry) => [entry.agentId, entry] as const),');
  lines.push(');');
  lines.push('');
  lines.push('type BuiltInBackendCatalogDefinition = (ReturnType<typeof getAllBackendDefinitions>)[number];');
  lines.push('');
  lines.push('function buildBundledSourceSpec(metadata: BundledFirstPartyPluginMetadata) {');
  lines.push('  return {');
  lines.push('    kind: \'package\' as const,');
  lines.push('    locator: metadata.packageName,');
  lines.push('    trustPolicy: \'local_trusted\' as const,');
  lines.push('    installPolicy: \'link\' as const,');
  lines.push('    resolvedVersion: metadata.packageVersion,');
  lines.push('    resolvedDigest: metadata.manifestDigest,');
  lines.push('  };');
  lines.push('}');
  lines.push('');
  lines.push('function readBundledPluginMetadata(agentId: string): BundledFirstPartyPluginMetadata | null {');
  lines.push('  return bundledPluginMetadataByAgentId.get(agentId) ?? null;');
  lines.push('}');
  lines.push('');
  lines.push('function requireBuiltInAgentId(value: string, subject: string): AgentId {');
  lines.push('  if (!isAgentId(value)) {');
  lines.push('    throw new Error(`Expected built-in ${subject} id, received \'${value}\'`);');
  lines.push('  }');
  lines.push('  return value;');
  lines.push('}');
  lines.push('');
  lines.push('function buildBundledMetadataFields(agentId: string): Partial<BundledContributionMetadataFields> {');
  lines.push('  const metadata = readBundledPluginMetadata(agentId);');
  lines.push('  if (!metadata) return {};');
  lines.push('  return {');
  lines.push('    pluginId: metadata.pluginId,');
  lines.push('    manifestPath: metadata.manifestPath,');
  lines.push('    manifestDigest: metadata.manifestDigest,');
  lines.push('    daemonEntryPath: metadata.packageName,');
  lines.push('    sourceSpec: buildBundledSourceSpec(metadata),');
  lines.push('  };');
  lines.push('}');
  lines.push('');
  lines.push('export const BUNDLED_FIRST_PARTY_ACTIVATION_TARGETS: readonly ResolvedActivationTarget[] = Object.freeze(');
  lines.push('  BUNDLED_FIRST_PARTY_PLUGIN_METADATA.map((metadata): ResolvedActivationTarget => ({');
  lines.push('    provenance: \'first_party\',');
  lines.push('    source: { kind: \'bundled\' },');
  lines.push('    pluginId: metadata.pluginId,');
  lines.push('    manifestPath: metadata.manifestPath,');
  lines.push('    manifestDigest: metadata.manifestDigest,');
  lines.push('    daemonEntryPath: metadata.packageName,');
  lines.push('    sourceSpec: buildBundledSourceSpec(metadata),');
  lines.push('  })),');
  lines.push(');');
  lines.push('');
  lines.push('export const BUNDLED_FIRST_PARTY_PROVIDER_CONTRIBUTIONS: readonly ResolvedProviderContribution[] = Object.freeze(');
  lines.push('  getAllProviderDefinitionContracts().map((definition): ResolvedProviderContribution => {');
  lines.push('    const providerId = requireBuiltInAgentId(definition.id, \'provider\');');
  lines.push('    const richDefinition = getProviderDefinition(providerId);');
  lines.push('    if (!richDefinition) {');
  lines.push('      throw new Error(`Missing built-in provider catalog definition \'${definition.id}\'`);');
  lines.push('    }');
  lines.push('    const catalogEntry = Object.freeze({');
  lines.push('      id: definition.id,');
  lines.push('      cliSubcommand: richDefinition.core.cliSubcommand,');
  lines.push('      vendorResumeSupport: richDefinition.core.resume.vendorResume,');
  lines.push('    } satisfies ResolvedCatalogEntry);');
  lines.push('    return Object.freeze({');
  lines.push('      id: definition.id,');
  lines.push('      provenance: \'first_party\',');
  lines.push('      source: { kind: \'bundled\' },');
  lines.push('      definition,');
  lines.push('      richDefinition: {');
  lines.push('        provenance: \'first_party\',');
  lines.push('        definition: richDefinition,');
  lines.push('      },');
  lines.push('      runtimeSpec: getProviderCliRuntimeSpec(providerId),');
  lines.push('      catalogEntry,');
  lines.push('      ...buildBundledMetadataFields(definition.id),');
  lines.push('    } satisfies ResolvedProviderContribution);');
  lines.push('  }),');
  lines.push(');');
  lines.push('');
  lines.push('export const BUNDLED_FIRST_PARTY_SCM_HOSTING_PROVIDER_CONTRIBUTIONS: readonly ResolvedScmHostingProviderContribution[] = Object.freeze([');
  for (const contribution of scmHostingProviderContributions) {
    lines.push('  Object.freeze({');
    lines.push(`    id: ${JSON.stringify(contribution.id)},`);
    lines.push('    provenance: \'first_party\',');
    lines.push('    source: { kind: \'bundled\' },');
    lines.push(`    pluginId: ${JSON.stringify(contribution.metadata.pluginId)},`);
    lines.push('    identity: {');
    lines.push(`      pluginId: ${JSON.stringify(contribution.metadata.pluginId)},`);
    lines.push('      family: \'scmHostingProviders\',');
    lines.push(`      contributionId: ${JSON.stringify(contribution.id)},`);
    lines.push('      provenance: \'first_party\',');
    lines.push('    },');
    lines.push(`    manifestPath: ${JSON.stringify(contribution.metadata.manifestPath)},`);
    lines.push(`    manifestDigest: ${JSON.stringify(contribution.metadata.manifestDigest)},`);
    lines.push(`    daemonEntryPath: ${JSON.stringify(contribution.metadata.packageName)},`);
    lines.push(`    sourceSpec: ${renderJsonLiteral({
      kind: 'package',
      locator: contribution.metadata.packageName,
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: contribution.metadata.packageVersion,
      resolvedDigest: contribution.metadata.manifestDigest,
    })},`);
    lines.push(`    definition: Object.freeze(${renderJsonLiteral(contribution.definition)} as const satisfies ResolvedScmHostingProviderContribution['definition']),`);
    lines.push('  } satisfies ResolvedScmHostingProviderContribution),');
  }
  lines.push(']);');
  lines.push('');
  lines.push('export const BUNDLED_FIRST_PARTY_INSTALLABLE_CONTRIBUTIONS: readonly ResolvedInstallableContribution[] = Object.freeze([');
  for (const contribution of installableContributions) {
    lines.push('  Object.freeze({');
    lines.push('    provenance: \'first_party\',');
    lines.push('    source: { kind: \'bundled\' },');
    lines.push(`    pluginId: ${JSON.stringify(contribution.metadata.pluginId)},`);
    lines.push(`    manifestPath: ${JSON.stringify(contribution.metadata.manifestPath)},`);
    lines.push(`    manifestDigest: ${JSON.stringify(contribution.metadata.manifestDigest)},`);
    lines.push(`    daemonEntryPath: ${JSON.stringify(contribution.metadata.packageName)},`);
    lines.push(`    sourceSpec: ${renderJsonLiteral({
      kind: 'package',
      locator: contribution.metadata.packageName,
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: contribution.metadata.packageVersion,
      resolvedDigest: contribution.metadata.manifestDigest,
    })},`);
    lines.push(`    definition: Object.freeze(${renderJsonLiteral(contribution.definition)} as const satisfies ResolvedInstallableContribution['definition']),`);
    lines.push('  } satisfies ResolvedInstallableContribution),');
  }
  lines.push(']);');
  lines.push('');
  lines.push('export const BUNDLED_FIRST_PARTY_SCM_BACKEND_CONTRIBUTIONS: readonly ResolvedScmBackendContribution[] = Object.freeze([');
  for (const contribution of scmBackendContributions) {
    lines.push('  Object.freeze({');
    lines.push(`    id: ${JSON.stringify(contribution.id)},`);
    lines.push('    provenance: \'first_party\',');
    lines.push('    source: { kind: \'bundled\' },');
    lines.push(`    pluginId: ${JSON.stringify(contribution.metadata.pluginId)},`);
    lines.push('    identity: {');
    lines.push(`      pluginId: ${JSON.stringify(contribution.metadata.pluginId)},`);
    lines.push('      family: \'scmBackends\',');
    lines.push(`      contributionId: ${JSON.stringify(contribution.id)},`);
    lines.push('      provenance: \'first_party\',');
    lines.push('    },');
    lines.push(`    manifestPath: ${JSON.stringify(contribution.metadata.manifestPath)},`);
    lines.push(`    manifestDigest: ${JSON.stringify(contribution.metadata.manifestDigest)},`);
    lines.push(`    daemonEntryPath: ${JSON.stringify(contribution.metadata.packageName)},`);
    lines.push(`    sourceSpec: ${renderJsonLiteral({
      kind: 'package',
      locator: contribution.metadata.packageName,
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: contribution.metadata.packageVersion,
      resolvedDigest: contribution.metadata.manifestDigest,
    })},`);
    lines.push(`    definition: Object.freeze(${renderJsonLiteral(contribution.definition)} as const satisfies ResolvedScmBackendContribution['definition']),`);
    lines.push('  } satisfies ResolvedScmBackendContribution),');
  }
  lines.push(']);');
  lines.push('');
  lines.push('export const BUNDLED_FIRST_PARTY_CONNECTED_ACCOUNT_DESCRIPTOR_CONTRIBUTIONS: readonly ResolvedConnectedAccountDescriptorContribution[] = Object.freeze([');
  for (const contribution of connectedAccountDescriptorContributions) {
    lines.push('  Object.freeze({');
    lines.push('    provenance: \'first_party\',');
    lines.push('    source: { kind: \'bundled\' },');
    lines.push(`    pluginId: ${JSON.stringify(contribution.metadata.pluginId)},`);
    lines.push(`    manifestPath: ${JSON.stringify(contribution.metadata.manifestPath)},`);
    lines.push(`    manifestDigest: ${JSON.stringify(contribution.metadata.manifestDigest)},`);
    lines.push(`    daemonEntryPath: ${JSON.stringify(contribution.metadata.packageName)},`);
    lines.push(`    sourceSpec: ${renderJsonLiteral({
      kind: 'package',
      locator: contribution.metadata.packageName,
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: contribution.metadata.packageVersion,
      resolvedDigest: contribution.metadata.manifestDigest,
    })},`);
    lines.push(`    definition: Object.freeze(${renderJsonLiteral(contribution.definition)} satisfies ResolvedConnectedAccountDescriptorContribution['definition']),`);
    lines.push('  } satisfies ResolvedConnectedAccountDescriptorContribution),');
  }
  lines.push(']);');
  lines.push('');
  lines.push('const backendCatalogDefinitionsById = new Map<AgentId, BuiltInBackendCatalogDefinition>(');
  lines.push('  getAllBackendDefinitions().map((definition) => [definition.id, definition] as const),');
  lines.push(');');
  lines.push('');
  lines.push('export const BUNDLED_FIRST_PARTY_BACKEND_CONTRIBUTIONS: readonly ResolvedBackendContribution[] = Object.freeze(');
  lines.push('  getAllBackendDefinitionContracts().map((definition): ResolvedBackendContribution => {');
  lines.push('    const backendId = requireBuiltInAgentId(definition.id, \'backend\');');
  lines.push('    const richDefinition = backendCatalogDefinitionsById.get(backendId);');
  lines.push('    if (!richDefinition) {');
  lines.push('      throw new Error(`Missing built-in backend catalog definition \'${definition.id}\'`);');
  lines.push('    }');
  lines.push('    return Object.freeze({');
  lines.push('      id: definition.id,');
  lines.push('      providerId: definition.providerId,');
  lines.push('      provenance: \'first_party\',');
  lines.push('      source: { kind: \'bundled\' },');
  lines.push('      definition,');
  lines.push('      richDefinition: {');
  lines.push('        provenance: \'first_party\',');
  lines.push('        definition: richDefinition,');
  lines.push('      },');
  lines.push('      runtimeKind: richDefinition.engine?.defaultRuntimeKind ?? \'native\',');
  lines.push('      ...buildBundledMetadataFields(definition.providerId),');
  lines.push('    } satisfies ResolvedBackendContribution);');
  lines.push('  }),');
  lines.push(');');
  lines.push('');
  lines.push('export const BUNDLED_FIRST_PARTY_CATALOG_ENTRIES: readonly ResolvedCatalogEntry[] = Object.freeze(');
  lines.push('  BUNDLED_FIRST_PARTY_PROVIDER_CONTRIBUTIONS.map((provider) => provider.catalogEntry)');
  lines.push('    .filter((entry): entry is ResolvedCatalogEntry => Boolean(entry)),');
  lines.push(');');
  lines.push('');
  return lines.join('\n');
}

function patchBundledPluginPackageNamesConstant(params: Readonly<{
  filePath: string;
  packageNames: readonly string[];
}>): void {
  const existing = readFileSync(params.filePath, 'utf8');
  const replacement = `export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES: readonly string[] = Object.freeze(${JSON.stringify(params.packageNames, null, 2)});\n`;
  const pattern = /export const BUNDLED_FIRST_PARTY_(?:EXTENSION|PLUGIN)_PACKAGE_NAMES:[^=]*=\s*Object\.freeze\([\s\S]*?\);\n?/;

  if (!pattern.test(existing)) {
    // If the file doesn't match the expected pattern, refuse to mutate it implicitly.
    throw new Error(`Unable to patch bundled first-party plugin package names in ${params.filePath}`);
  }

  const next = existing.replace(pattern, replacement);
  if (next === existing) {
    return;
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
  const pluginPackages = await readBundledPluginPackages(options.rootDir);
  const packageNames = pluginPackages.map((entry) => entry.packageName);
  const agentIds = pluginPackages
    .map((entry) => entry.agentId)
    .filter((agentId): agentId is string => typeof agentId === 'string')
    .sort((a, b) => a.localeCompare(b));
  const agentDefinitionsById = Object.fromEntries(
    pluginPackages
      .filter((entry): entry is AgentBundledPluginPackage => (
        typeof entry.agentId === 'string' && entry.agentDefinition !== undefined
      ))
      .map((entry) => [entry.agentId, entry.agentDefinition]),
  );

  const cliOutPath = resolve(options.rootDir, 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPlugins.ts');
  const uiOutPath = resolve(options.rootDir, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts');
  const uiBehaviorOverridesOutPath = resolve(
    options.rootDir,
    'apps/ui/sources/agents/registry/generatedBundledPluginEntries.uiBehaviorOverrides.ts',
  );
  const agentsOutPath = resolve(options.rootDir, 'packages/agents/src/generated/bundledAgentDefinitions.ts');

  const cliOut = renderCliBundledPluginEntriesTs({ pluginPackages });

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
    patchBundledPluginPackageNamesConstant({ filePath: uiOutPath, packageNames });
  }

  if (!existsSync(uiBehaviorOverridesOutPath)) {
    writeFileAtomic(uiBehaviorOverridesOutPath, renderBundledUiBehaviorOverridesPlaceholderTs());
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
