import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  CANONICAL_AGENTS_CORE,
  getAllBackendDefinitions,
  getAllBackendDefinitionContracts,
  getAllProviderDefinitionContracts,
  getProviderDefinition,
  getAgentCliRuntimeSpec,
} from '@happier-dev/agents';
import type { AgentId } from '@happier-dev/agents';
import {
  BackendSurfaceOperationCatalogV1,
  PluginManifestV2Schema,
  PluginPromptAssetContributionV1Schema,
} from '@happier-dev/protocol';
import type { PluginPromptAssetContributionV1 } from '@happier-dev/protocol';

type TsImport = (specifier: string, parentURL: string) => Promise<unknown>;

const PLUGIN_PACKAGE_PREFIX = '@happier-dev/plugins-';

type Mode = 'write' | 'check';

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = Readonly<{ [key: string]: JsonValue }>;
type PluginManifestJson = JsonObject & Readonly<{ id: string }>;
type BundledManifestContribution = Readonly<{
  id: string;
  definition: JsonValue;
  metadata: BundledFirstPartyPluginMetadataSource;
}>;
type BundledFirstPartyPluginMetadataSource = Readonly<{
  agentId?: string;
  manifestDigest: string;
  manifestPath: string;
  packageName: string;
  packageVersion: string;
  pluginId: string;
  pluginPackageId: string;
}>;
type BundledPluginPackage = Readonly<{
  pluginPackageId: string;
  pluginId: string;
  packageName: string;
  packageVersion: string;
  manifest: PluginManifestJson;
  agentId?: string;
  agentDefinition?: JsonValue;
  agentUiDescriptor?: AgentUiDescriptor;
  agentRuntimeContributions?: AgentRuntimeContributionsDescriptor;
  promptAssetContributions?: PromptAssetContributionSource;
}>;
type AgentBundledPluginPackage = BundledPluginPackage & Readonly<{
  agentId: string;
  agentDefinition: JsonValue;
}>;
type AgentUiDescriptor = Readonly<{
  kind: 'plugin.ui.v1';
  pluginId: string;
  agentId: string;
  version: number;
  display: Readonly<{
    nameKey: string;
    subtitleKey: string;
    permissionModeI18nPrefix: string;
    availability: Readonly<{ experimental: boolean }>;
    connectedService: Readonly<{
      serviceId: string | null;
      labelKey: string;
      connectRoute: string | null;
    }>;
    flavorAliases: readonly string[];
    permissions: Readonly<{
      modeGroup: string;
      promptProtocol: string;
    }>;
    sessionModes?: Readonly<{
      staticOptions?: readonly AgentUiSessionModeOption[];
    }>;
    runtimeInput?: Readonly<{
      inFlightSteerSupported: boolean;
    }>;
    resume: Readonly<{
      uiVendorResumeIdLabelKey: string | null;
      uiVendorResumeIdCopiedKey: string | null;
    }>;
    localControl?: boolean;
    toolRendering: Readonly<{ hideUnknownToolsByDefault: boolean }>;
    picker: Readonly<{
      iconName: string;
      iconScale?: number;
      cliGlyphTokenId: string;
      cliGlyphScale: number;
      profileCompatibilityGlyphScale: number;
    }>;
    avatarOverlay: Readonly<{
      circleScale: number;
      iconScaleRatio: number;
    }>;
    icon?: Readonly<{ assetId: string | null }>;
  }>;
  settings?: JsonObject;
  behavior?: JsonObject;
  session?: JsonObject;
  message?: JsonObject;
  components?: JsonObject;
  assets?: JsonObject;
}>;
type AgentRuntimeContributionsDescriptor = Readonly<{
  providerCatalogEntry?: AgentRuntimeProjectionImportDescriptor;
  sessionControlAdapter?: SessionControlAdapterContributionDescriptor;
  runtimeDescriptorReader?: RuntimeDescriptorReaderContributionDescriptor;
  protocolRuntimeDescriptor?: ProtocolRuntimeDescriptorContributionDescriptor;
  protocolBuiltInBackendProfiles?: ProtocolBuiltInBackendProfilesContributionDescriptor;
  protocolMemoryDefaults?: ProtocolMemoryDefaultsContributionDescriptor;
  protocolExternalSessionSource?: ProtocolExternalSessionSourceContributionDescriptor;
  externalSessionHostAdapters?: ExternalSessionHostAdaptersContributionDescriptor;
}>;
type AgentRuntimeProjectionImportDescriptor = Readonly<{
  importName: string;
  source: string;
}>;
type RuntimeProjectionExportDescriptor = Readonly<{
  source: string;
  exportName: string;
}>;
type ExternalSessionHostAdaptersContributionDescriptor = Readonly<{
  kind: 'providerExternalSessionHostAdaptersV1';
  providerId: string;
  candidateHostAdapter?: RuntimeProjectionExportDescriptor;
  transcriptStoreAdapter?: RuntimeProjectionExportDescriptor;
}>;
type RuntimeDescriptorResumeIdSessionControlContributionDescriptor = Readonly<{
  kind: 'runtimeDescriptorResumeId';
  providerId: string;
  absolutePathField?: string;
  fallbackField: string;
}>;
type ProviderSessionControlAdapterContributionDescriptor = Readonly<{
  kind: 'providerSessionControlAdapter';
  providerId: string;
  source: string;
  exportName: string;
}>;
type SessionControlAdapterContributionDescriptor =
  | RuntimeDescriptorResumeIdSessionControlContributionDescriptor
  | ProviderSessionControlAdapterContributionDescriptor;
type ProviderSessionIdRuntimeDescriptorReaderContributionDescriptor = Readonly<{
  kind: 'providerSessionId';
  providerId: string;
  runtimeHandle: 'providerSessionId';
}>;
type ProviderRuntimeDescriptorReaderContributionDescriptor = Readonly<{
  kind: 'providerRuntimeDescriptorReader';
  providerId: string;
  source: string;
  exportName: string;
}>;
type RuntimeDescriptorReaderContributionDescriptor =
  | ProviderSessionIdRuntimeDescriptorReaderContributionDescriptor
  | ProviderRuntimeDescriptorReaderContributionDescriptor;
type ProtocolRuntimeDescriptorContributionDescriptor = Readonly<{
  kind: 'providerRuntimeDescriptorV1';
  providerId: string;
  source: string;
  buildFunction: string;
  canonicalReader: string;
}>;
type ProtocolBuiltInBackendProfilesContributionDescriptor = Readonly<{
  kind: 'providerBuiltInBackendProfilesV1';
  providerId: string;
  source: string;
  exportName: string;
}>;
type ProtocolMemoryDefaultsContributionDescriptor = Readonly<{
  kind: 'providerMemoryDefaultsV1';
  providerId: string;
  source: string;
  exportName: string;
}>;
type ProtocolExternalSessionSourceContributionDescriptor = Readonly<{
  kind: 'providerExternalSessionSourceV1';
  providerId: string;
  source: string;
  exportName: string;
}>;
type SessionControlAdapterProjectionDescriptor =
  | RuntimeDescriptorResumeIdSessionControlContributionDescriptor
  | ProviderSessionControlAdapterContributionDescriptor;
type RuntimeDescriptorReaderProjectionDescriptor =
  | ProviderSessionIdRuntimeDescriptorReaderContributionDescriptor
  | ProviderRuntimeDescriptorReaderContributionDescriptor;
type ProtocolRuntimeDescriptorProjectionDescriptor = ProtocolRuntimeDescriptorContributionDescriptor & Readonly<{
  generatedImportSource: string;
  moduleFileName: string;
  sourceContent: string;
}>;
type ProtocolBuiltInBackendProfilesProjectionDescriptor = ProtocolBuiltInBackendProfilesContributionDescriptor & Readonly<{
  profiles: readonly JsonObject[];
}>;
type ProtocolMemoryDefaultsProjectionDescriptor = ProtocolMemoryDefaultsContributionDescriptor & Readonly<{
  summarizerBackendId: string;
}>;
type ExternalSessionSchemaFieldDescriptor = Readonly<{
  name: string;
  kind: 'literal' | 'string' | 'enum' | 'unknown';
  value?: string;
  values?: readonly string[];
  min?: number;
  max?: number;
  optional?: boolean;
  nullish?: boolean;
}>;
type ExternalSessionSchemaRefinementDescriptor =
  | Readonly<{
    kind: 'requiresWhenEquals';
    field: string;
    when: Readonly<{ field: string; equals: string }>;
  }>
  | Readonly<{
    kind: 'forbidsWhenEquals';
    fields: readonly string[];
    when: Readonly<{ field: string; equals: string }>;
  }>;
type ExternalSessionKeySegmentDescriptor =
  | Readonly<{ kind: 'literal'; value: string }>
  | Readonly<{ kind: 'field'; field: string }>
  | Readonly<{ kind: 'homeMode'; field: string }>
  | Readonly<{ kind: 'conditionalField'; field: string; when: Readonly<{ field: string; equals: string }> }>
  | Readonly<{
    kind: 'connectedServiceScope';
    groupField: string;
    profileField: string;
    when: Readonly<{ field: string; equals: string }>;
  }>;
type ExternalSessionSourceDeclaration = Readonly<{
  providerId: string;
  sourceKind: string;
  schema: Readonly<{
    passthrough?: boolean;
    fields: readonly ExternalSessionSchemaFieldDescriptor[];
    refinements?: readonly ExternalSessionSchemaRefinementDescriptor[];
  }>;
  key: Readonly<{
    segments: readonly ExternalSessionKeySegmentDescriptor[];
  }>;
}>;
type ProtocolExternalSessionSourceProjectionDescriptor = ProtocolExternalSessionSourceContributionDescriptor & Readonly<{
  declaration: ExternalSessionSourceDeclaration;
}>;
type AgentCliRuntimeSpecSource = Readonly<{
  agentId: string;
  runtimeSpec: JsonValue;
}>;
type AgentCommandSurfaceSource = Readonly<{
  rootHelpLabel?: string;
  rootHelpDescription?: string;
  rootHelpDetail?: string;
  allowTmux?: boolean;
}>;
type BuiltInProviderContributionSource = Readonly<{
  id: string;
  definition: JsonValue;
  runtimeSpec: JsonValue;
  cliSubcommand: string;
  vendorResumeSupport: string;
  commandSurface?: AgentCommandSurfaceSource;
}>;
type BuiltInBackendContributionSource = Readonly<{
  id: string;
  providerId: string;
  definition: JsonValue;
  runtimeKind: string;
}>;
type AgentUiSessionModeOption = Readonly<{
  id: string;
  nameKey: string;
  descriptionKey?: string;
}>;
type GeneratedAgentUiProjectionSource = Readonly<{
  agentId: string;
  coreConst: string;
  uiConst: string;
  renderLines: () => readonly string[];
}>;
type DescriptorAgentUiProjectionSource = Readonly<{
  agentId: string;
  coreConst: string;
  uiConst: string;
  descriptor: AgentUiDescriptor;
  svgIcon?: DescriptorGeneratedSvgIconSource;
}>;
type DescriptorGeneratedSvgIconPathSource = Readonly<{
  d: string;
  fillToken?: string;
  fillOpacity?: number;
  fillRule?: 'evenodd' | 'nonzero';
  clipRule?: 'evenodd' | 'nonzero';
}>;
type DescriptorGeneratedSvgIconSource = Readonly<{
  constName: string;
  viewBox: string;
  paths: readonly DescriptorGeneratedSvgIconPathSource[];
}>;
type AgentUiBehaviorOverrideSource = Readonly<{
  agentId: string;
  descriptor: JsonObject;
}>;
type AgentSessionProviderBehaviorSource = Readonly<{
  agentId: string;
  descriptor: JsonObject;
}>;
type ProviderMessageMetaOverrideSource = Readonly<{
  agentId: string;
  descriptor: JsonObject;
}>;
type ProviderSettingsSource = Readonly<{
  agentId: string;
  descriptor: JsonObject;
}>;
type SessionSubagentVisibleMessageResolverSource = Readonly<{
  agentId: string;
  descriptor: JsonObject;
}>;
type ProviderCatalogEntryHookSource = Readonly<{
  agentId: string;
  importName: string;
  importPath: string;
  packageName: string;
  systemTools: readonly JsonValue[];
  externalSessionHostAdapters?: Readonly<{
    candidateHostAdapter?: ExternalSessionHostAdapterImportSource;
    transcriptStoreAdapter?: ExternalSessionHostAdapterImportSource;
  }>;
}>;
type ExternalSessionHostAdapterImportSource = Readonly<{
  exportName: string;
  importAlias: string;
  importPath: string;
}>;
type PromptAssetContributionSource = Readonly<{
  importName: string;
  importPath: string;
  pluginPackageId: string;
}>;

const GENERATED_AGENT_UI_PROJECTION_SOURCES: readonly GeneratedAgentUiProjectionSource[] = Object.freeze([
  { agentId: 'qwen', coreConst: 'QWEN_CORE', uiConst: 'QWEN_UI', renderLines: renderQwenGeneratedUiProjectionLines },
  { agentId: 'kiro', coreConst: 'KIRO_CORE', uiConst: 'KIRO_UI', renderLines: renderKiroGeneratedUiProjectionLines },
]);
const AGENT_CLI_GLYPH_BY_TOKEN_ID: Readonly<Record<string, string>> = Object.freeze({
  'agentGlyph.auggie': 'A',
  'agentGlyph.claude': '✳︎',
  'agentGlyph.codex': '꩜',
  'agentGlyph.copilot': 'CP',
  'agentGlyph.cursor': 'CU',
  'agentGlyph.gemini': '✦︎',
  'agentGlyph.kilo': 'KL',
  'agentGlyph.kimi': 'K',
  'agentGlyph.kiro': 'KR',
  'agentGlyph.ohMyPi': 'OMP',
  'agentGlyph.opencode': '</>',
  'agentGlyph.pi': 'PI',
  'agentGlyph.qwen': 'Q',
});
const AGENT_CONNECTED_SERVICE_LABEL_BY_TOKEN_ID: Readonly<Record<string, string>> = Object.freeze({
  'agentInput.agent.auggie': 'Auggie',
  'agentInput.agent.claude': 'Claude Code',
  'agentInput.agent.codex': 'OpenAI Codex',
  'agentInput.agent.copilot': 'GitHub Copilot',
  'agentInput.agent.cursor': 'Cursor',
  'agentInput.agent.gemini': 'Google Gemini',
  'agentInput.agent.kilo': 'Kilo',
  'agentInput.agent.kimi': 'Kimi',
  'agentInput.agent.ohMyPi': 'oh-my-pi',
  'agentInput.agent.opencode': 'OpenCode',
  'agentInput.agent.pi': 'Pi',
});
const AGENT_UI_PROJECTION_ORDER = Object.freeze([
  'claude',
  'codex',
  'cursor',
  'opencode',
  'gemini',
  'auggie',
  'qwen',
  'kimi',
  'kilo',
  'kiro',
  'pi',
  'ohMyPi',
  'copilot',
]);
const STABLE_AGENT_PROVIDER_ID_ORDER = Object.freeze([
  'claude',
  'codex',
  'opencode',
  'gemini',
  'auggie',
  'qwen',
  'kimi',
  'kilo',
  'kiro',
  'cursor',
  'ohMyPi',
  'pi',
  'copilot',
] as const);
const PROTOCOL_AGENT_PROVIDER_IDS_V1 = Object.freeze([
  'claude',
  'codex',
  'opencode',
  'pi',
  'ohMyPi',
] as const);
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

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function normalizeJsonSerializableValue(value: unknown, path: string[] = []): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (t === 'bigint' || t === 'symbol' || t === 'function') {
    throw new Error(`Non-JSON value at ${path.join('.') || '<root>'}: ${t}`);
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => (
      normalizeJsonSerializableValue(entry, [...path, String(index)]) ?? null
    ));
  }
  if (!isRecord(value)) {
    throw new Error(`Non-JSON object at ${path.join('.') || '<root>'}`);
  }
  const out: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalized = normalizeJsonSerializableValue(entry, [...path, key]);
    if (normalized !== undefined) {
      out[key] = normalized;
    }
  }
  return out;
}

function readJsonSerializableValue(value: unknown, subject: string): JsonValue {
  const normalized = normalizeJsonSerializableValue(value, [subject]);
  if (normalized === undefined) {
    throw new Error(`Non-JSON value at ${subject}: undefined`);
  }
  return normalized;
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

function readRequiredContributionString(
  value: JsonValue,
  key: string,
  family: string,
  pluginPackageId: string,
): string {
  if (!isJsonObject(value) || typeof value[key] !== 'string' || value[key].trim().length === 0) {
    throw new Error(`Invalid ${family} contribution in ${pluginPackageId}: expected object with non-empty string ${key}`);
  }
  return value[key];
}

function readOptionalJsonStringProperty(value: JsonValue, key: string): string | null {
  if (!isJsonObject(value)) return null;
  const property = value[key];
  return typeof property === 'string' && property.trim().length > 0 ? property : null;
}

function readJsonObjectProperty(value: JsonValue, key: string): JsonObject | null {
  if (!isJsonObject(value)) return null;
  const property = value[key];
  return isJsonObject(property) ? property : null;
}

function readJsonArrayProperty(value: JsonValue, key: string): readonly JsonValue[] {
  if (!isJsonObject(value)) return [];
  const property = value[key];
  return Array.isArray(property) ? property : [];
}

function hasTerminalRuntimeLaunchSurfaceContribution(definition: JsonValue): boolean {
  return readJsonArrayProperty(definition, 'surfaceHandlers').some((surfaceHandler) => (
    isJsonObject(surfaceHandler)
    && surfaceHandler.kind === 'terminalRuntime'
    && surfaceHandler.operation === BackendSurfaceOperationCatalogV1.terminalRuntime.launch
  ));
}

function isProviderlessReviewExecutionRunBackendContribution(definition: JsonValue): boolean {
  const capabilities = readJsonObjectProperty(definition, 'capabilities');
  const session = capabilities ? readJsonObjectProperty(capabilities, 'session') : null;
  const executionRun = capabilities ? readJsonObjectProperty(capabilities, 'executionRun') : null;
  return session?.supported === false
    && executionRun !== null
    && executionRun.supported !== false
    && isJsonObject(executionRun.review)
    && !hasTerminalRuntimeLaunchSurfaceContribution(definition);
}

function readRequiredRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Invalid agent UI descriptor at ${path}: expected object`);
  }
  return value;
}

function readRequiredString(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid agent UI descriptor at ${path}.${key}: expected non-empty string`);
  }
  return value;
}

function readOptionalString(record: Record<string, unknown>, key: string, path: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid agent UI descriptor at ${path}.${key}: expected non-empty string when present`);
  }
  return value;
}

function readRequiredBoolean(record: Record<string, unknown>, key: string, path: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid agent UI descriptor at ${path}.${key}: expected boolean`);
  }
  return value;
}

function readRequiredNumber(record: Record<string, unknown>, key: string, path: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid agent UI descriptor at ${path}.${key}: expected finite number`);
  }
  return value;
}

function readOptionalBoolean(record: Record<string, unknown>, key: string, path: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid agent UI descriptor at ${path}.${key}: expected boolean`);
  }
  return value;
}

function readOptionalNumber(record: Record<string, unknown>, key: string, path: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid agent UI descriptor at ${path}.${key}: expected finite number`);
  }
  return value;
}

function readNullableString(record: Record<string, unknown>, key: string, path: string): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`Invalid agent UI descriptor at ${path}.${key}: expected string or null`);
  }
  return value;
}

function readStringArray(record: Record<string, unknown>, key: string, path: string): readonly string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Invalid agent UI descriptor at ${path}.${key}: expected string array`);
  }
  return value;
}

function readOptionalAgentUiSessionModes(
  record: Record<string, unknown>,
  path: string,
): AgentUiDescriptor['display']['sessionModes'] {
  const value = record.sessionModes;
  if (value === undefined) return undefined;
  const sessionModes = readRequiredRecord(value, `${path}.sessionModes`);
  const staticOptions = sessionModes.staticOptions;
  if (staticOptions === undefined) return {};
  if (!Array.isArray(staticOptions)) {
    throw new Error(`Invalid agent UI descriptor at ${path}.sessionModes.staticOptions: expected array`);
  }
  return {
    staticOptions: staticOptions.map((entry, index) => {
      const option = readRequiredRecord(entry, `${path}.sessionModes.staticOptions[${String(index)}]`);
      const descriptionKey = option.descriptionKey;
      if (descriptionKey !== undefined && typeof descriptionKey !== 'string') {
        throw new Error(
          `Invalid agent UI descriptor at ${path}.sessionModes.staticOptions[${String(index)}].descriptionKey: expected string`,
        );
      }
      return {
        id: readRequiredString(option, 'id', `${path}.sessionModes.staticOptions[${String(index)}]`),
        nameKey: readRequiredString(option, 'nameKey', `${path}.sessionModes.staticOptions[${String(index)}]`),
        ...(descriptionKey === undefined ? {} : { descriptionKey }),
      };
    }),
  };
}

function readOptionalJsonObjectDescriptor(
  record: Record<string, unknown>,
  key: string,
  path: string,
): JsonObject | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  const descriptor = readRequiredRecord(value, `${path}.${String(key)}`);
  const normalized = readJsonSerializableValue(descriptor, `${path}.${String(key)}`);
  if (!isJsonObject(normalized)) {
    throw new Error(`Invalid agent UI descriptor at ${path}.${String(key)}: expected object`);
  }
  return normalized;
}

function readOptionalAgentRuntimeProjectionImportDescriptor(
  record: Record<string, unknown>,
  key: keyof AgentRuntimeContributionsDescriptor,
  path: string,
): AgentRuntimeProjectionImportDescriptor | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  const projection = readRequiredRecord(value, `${path}.${String(key)}`);
  return {
    importName: readRequiredString(projection, 'importName', `${path}.${String(key)}`),
    source: readRequiredString(projection, 'source', `${path}.${String(key)}`),
  };
}

function readOptionalSessionControlAdapterContribution(
  record: Record<string, unknown>,
  path: string,
): SessionControlAdapterContributionDescriptor | undefined {
  const value = record.sessionControlAdapter;
  if (value === undefined) return undefined;
  const contribution = readRequiredRecord(value, `${path}.sessionControlAdapter`);
  const kind = readRequiredString(contribution, 'kind', `${path}.sessionControlAdapter`);
  if (kind === 'providerSessionControlAdapter') {
    return {
      kind,
      providerId: readRequiredString(contribution, 'providerId', `${path}.sessionControlAdapter`),
      source: readRequiredString(contribution, 'source', `${path}.sessionControlAdapter`),
      exportName: readRequiredString(contribution, 'exportName', `${path}.sessionControlAdapter`),
    };
  }
  if (kind !== 'runtimeDescriptorResumeId') {
    throw new Error(
      `Invalid agent runtime contribution at ${path}.sessionControlAdapter.kind: expected runtimeDescriptorResumeId or providerSessionControlAdapter`,
    );
  }
  return {
    kind,
    providerId: readRequiredString(contribution, 'providerId', `${path}.sessionControlAdapter`),
    ...(readOptionalString(contribution, 'absolutePathField', `${path}.sessionControlAdapter`) === undefined
      ? {}
      : { absolutePathField: readOptionalString(contribution, 'absolutePathField', `${path}.sessionControlAdapter`) }),
    fallbackField: readRequiredString(contribution, 'fallbackField', `${path}.sessionControlAdapter`),
  };
}

function readOptionalRuntimeDescriptorReaderContribution(
  record: Record<string, unknown>,
  path: string,
): RuntimeDescriptorReaderContributionDescriptor | undefined {
  const value = record.runtimeDescriptorReader;
  if (value === undefined) return undefined;
  const contribution = readRequiredRecord(value, `${path}.runtimeDescriptorReader`);
  const kind = readRequiredString(contribution, 'kind', `${path}.runtimeDescriptorReader`);
  if (kind === 'providerRuntimeDescriptorReader') {
    return {
      kind,
      providerId: readRequiredString(contribution, 'providerId', `${path}.runtimeDescriptorReader`),
      source: readRequiredString(contribution, 'source', `${path}.runtimeDescriptorReader`),
      exportName: readRequiredString(contribution, 'exportName', `${path}.runtimeDescriptorReader`),
    };
  }
  if (kind !== 'providerSessionId') {
    throw new Error(
      `Invalid agent runtime contribution at ${path}.runtimeDescriptorReader.kind: expected providerSessionId or providerRuntimeDescriptorReader`,
    );
  }
  const runtimeHandle = readRequiredString(contribution, 'runtimeHandle', `${path}.runtimeDescriptorReader`);
  if (runtimeHandle !== 'providerSessionId') {
    throw new Error(`Invalid agent runtime contribution at ${path}.runtimeDescriptorReader.runtimeHandle: expected providerSessionId`);
  }
  return {
    kind,
    providerId: readRequiredString(contribution, 'providerId', `${path}.runtimeDescriptorReader`),
    runtimeHandle,
  };
}

function readOptionalProtocolRuntimeDescriptorContribution(
  record: Record<string, unknown>,
  path: string,
): ProtocolRuntimeDescriptorContributionDescriptor | undefined {
  const value = record.protocolRuntimeDescriptor;
  if (value === undefined) return undefined;
  const contribution = readRequiredRecord(value, `${path}.protocolRuntimeDescriptor`);
  const kind = readRequiredString(contribution, 'kind', `${path}.protocolRuntimeDescriptor`);
  if (kind !== 'providerRuntimeDescriptorV1') {
    throw new Error(`Invalid agent runtime contribution at ${path}.protocolRuntimeDescriptor.kind: expected providerRuntimeDescriptorV1`);
  }
  return {
    kind,
    providerId: readRequiredString(contribution, 'providerId', `${path}.protocolRuntimeDescriptor`),
    source: readRequiredString(contribution, 'source', `${path}.protocolRuntimeDescriptor`),
    buildFunction: readRequiredString(contribution, 'buildFunction', `${path}.protocolRuntimeDescriptor`),
    canonicalReader: readRequiredString(contribution, 'canonicalReader', `${path}.protocolRuntimeDescriptor`),
  };
}

function readOptionalProtocolBuiltInBackendProfilesContribution(
  record: Record<string, unknown>,
  path: string,
): ProtocolBuiltInBackendProfilesContributionDescriptor | undefined {
  const value = record.protocolBuiltInBackendProfiles;
  if (value === undefined) return undefined;
  const contribution = readRequiredRecord(value, `${path}.protocolBuiltInBackendProfiles`);
  const kind = readRequiredString(contribution, 'kind', `${path}.protocolBuiltInBackendProfiles`);
  if (kind !== 'providerBuiltInBackendProfilesV1') {
    throw new Error(
      `Invalid agent runtime contribution at ${path}.protocolBuiltInBackendProfiles.kind: expected providerBuiltInBackendProfilesV1`,
    );
  }
  return {
    kind,
    providerId: readRequiredString(contribution, 'providerId', `${path}.protocolBuiltInBackendProfiles`),
    source: readRequiredString(contribution, 'source', `${path}.protocolBuiltInBackendProfiles`),
    exportName: readRequiredString(contribution, 'exportName', `${path}.protocolBuiltInBackendProfiles`),
  };
}

function readOptionalProtocolMemoryDefaultsContribution(
  record: Record<string, unknown>,
  path: string,
): ProtocolMemoryDefaultsContributionDescriptor | undefined {
  const value = record.protocolMemoryDefaults;
  if (value === undefined) return undefined;
  const contribution = readRequiredRecord(value, `${path}.protocolMemoryDefaults`);
  const kind = readRequiredString(contribution, 'kind', `${path}.protocolMemoryDefaults`);
  if (kind !== 'providerMemoryDefaultsV1') {
    throw new Error(
      `Invalid agent runtime contribution at ${path}.protocolMemoryDefaults.kind: expected providerMemoryDefaultsV1`,
    );
  }
  return {
    kind,
    providerId: readRequiredString(contribution, 'providerId', `${path}.protocolMemoryDefaults`),
    source: readRequiredString(contribution, 'source', `${path}.protocolMemoryDefaults`),
    exportName: readRequiredString(contribution, 'exportName', `${path}.protocolMemoryDefaults`),
  };
}

function readOptionalProtocolExternalSessionSourceContribution(
  record: Record<string, unknown>,
  path: string,
): ProtocolExternalSessionSourceContributionDescriptor | undefined {
  const value = record.protocolExternalSessionSource;
  if (value === undefined) return undefined;
  const contribution = readRequiredRecord(value, `${path}.protocolExternalSessionSource`);
  const kind = readRequiredString(contribution, 'kind', `${path}.protocolExternalSessionSource`);
  if (kind !== 'providerExternalSessionSourceV1') {
    throw new Error(
      `Invalid agent runtime contribution at ${path}.protocolExternalSessionSource.kind: expected providerExternalSessionSourceV1`,
    );
  }
  return {
    kind,
    providerId: readRequiredString(contribution, 'providerId', `${path}.protocolExternalSessionSource`),
    source: readRequiredString(contribution, 'source', `${path}.protocolExternalSessionSource`),
    exportName: readRequiredString(contribution, 'exportName', `${path}.protocolExternalSessionSource`),
  };
}

function readOptionalRuntimeProjectionExportDescriptor(
  record: Record<string, unknown>,
  key: string,
  path: string,
): RuntimeProjectionExportDescriptor | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  const contribution = readRequiredRecord(value, `${path}.${key}`);
  return {
    source: readRequiredString(contribution, 'source', `${path}.${key}`),
    exportName: readRequiredString(contribution, 'exportName', `${path}.${key}`),
  };
}

function readOptionalExternalSessionHostAdaptersContribution(
  record: Record<string, unknown>,
  path: string,
): ExternalSessionHostAdaptersContributionDescriptor | undefined {
  const value = record.externalSessionHostAdapters;
  if (value === undefined) return undefined;
  const contribution = readRequiredRecord(value, `${path}.externalSessionHostAdapters`);
  const kind = readRequiredString(contribution, 'kind', `${path}.externalSessionHostAdapters`);
  if (kind !== 'providerExternalSessionHostAdaptersV1') {
    throw new Error(
      `Invalid agent runtime contribution at ${path}.externalSessionHostAdapters.kind: expected providerExternalSessionHostAdaptersV1`,
    );
  }
  const candidateHostAdapter = readOptionalRuntimeProjectionExportDescriptor(
    contribution,
    'candidateHostAdapter',
    `${path}.externalSessionHostAdapters`,
  );
  const transcriptStoreAdapter = readOptionalRuntimeProjectionExportDescriptor(
    contribution,
    'transcriptStoreAdapter',
    `${path}.externalSessionHostAdapters`,
  );
  if (!candidateHostAdapter && !transcriptStoreAdapter) {
    throw new Error(
      `Invalid agent runtime contribution at ${path}.externalSessionHostAdapters: expected candidateHostAdapter or transcriptStoreAdapter`,
    );
  }
  return {
    kind,
    providerId: readRequiredString(contribution, 'providerId', `${path}.externalSessionHostAdapters`),
    ...(candidateHostAdapter ? { candidateHostAdapter } : {}),
    ...(transcriptStoreAdapter ? { transcriptStoreAdapter } : {}),
  };
}

function readOptionalAgentRuntimeContributions(
  value: JsonValue,
  definitionPath: string,
): AgentRuntimeContributionsDescriptor | undefined {
  if (!isRecord(value)) return undefined;
  const rawRuntimeContributions = value.runtimeContributions;
  if (rawRuntimeContributions === undefined) return undefined;
  const runtimeContributions = readRequiredRecord(
    rawRuntimeContributions,
    `${definitionPath}.runtimeContributions`,
  );
  const providerCatalogEntry = readOptionalAgentRuntimeProjectionImportDescriptor(
    runtimeContributions,
    'providerCatalogEntry',
    `${definitionPath}.runtimeContributions`,
  );
  const sessionControlAdapter = readOptionalSessionControlAdapterContribution(
    runtimeContributions,
    `${definitionPath}.runtimeContributions`,
  );
  const runtimeDescriptorReader = readOptionalRuntimeDescriptorReaderContribution(
    runtimeContributions,
    `${definitionPath}.runtimeContributions`,
  );
  const protocolRuntimeDescriptor = readOptionalProtocolRuntimeDescriptorContribution(
    runtimeContributions,
    `${definitionPath}.runtimeContributions`,
  );
  const protocolBuiltInBackendProfiles = readOptionalProtocolBuiltInBackendProfilesContribution(
    runtimeContributions,
    `${definitionPath}.runtimeContributions`,
  );
  const protocolMemoryDefaults = readOptionalProtocolMemoryDefaultsContribution(
    runtimeContributions,
    `${definitionPath}.runtimeContributions`,
  );
  const protocolExternalSessionSource = readOptionalProtocolExternalSessionSourceContribution(
    runtimeContributions,
    `${definitionPath}.runtimeContributions`,
  );
  const externalSessionHostAdapters = readOptionalExternalSessionHostAdaptersContribution(
    runtimeContributions,
    `${definitionPath}.runtimeContributions`,
  );
  return {
    ...(providerCatalogEntry === undefined ? {} : { providerCatalogEntry }),
    ...(sessionControlAdapter === undefined ? {} : { sessionControlAdapter }),
    ...(runtimeDescriptorReader === undefined ? {} : { runtimeDescriptorReader }),
    ...(protocolRuntimeDescriptor === undefined ? {} : { protocolRuntimeDescriptor }),
    ...(protocolBuiltInBackendProfiles === undefined ? {} : { protocolBuiltInBackendProfiles }),
    ...(protocolMemoryDefaults === undefined ? {} : { protocolMemoryDefaults }),
    ...(protocolExternalSessionSource === undefined ? {} : { protocolExternalSessionSource }),
    ...(externalSessionHostAdapters === undefined ? {} : { externalSessionHostAdapters }),
  };
}

async function readConventionalAgentRuntimeContributions(
  repoRoot: string,
  pluginPackageId: string,
  agentId: string,
): Promise<AgentRuntimeContributionsDescriptor | undefined> {
  const source = './agent/contributions/runtime';
  const sourcePath = resolve(repoRoot, 'packages/plugins', pluginPackageId, 'src/agent/contributions/runtime.ts');
  if (!existsSync(sourcePath)) return undefined;

  const importName = `${toAgentConstPrefix(agentId)}_PROVIDER_RUNTIME_CONTRIBUTION`;
  const mod = await importTypescriptModule(sourcePath) as Record<string, unknown>;
  if (!(importName in mod)) {
    throw new Error(`Expected ${importName} export in ${sourcePath}`);
  }

  return {
    providerCatalogEntry: {
      importName,
      source,
    },
  };
}

function readOptionalAgentUiRuntimeInput(
  record: Record<string, unknown>,
  path: string,
): AgentUiDescriptor['display']['runtimeInput'] {
  const value = record.runtimeInput;
  if (value === undefined) return undefined;
  const runtimeInput = readRequiredRecord(value, `${path}.runtimeInput`);
  return {
    inFlightSteerSupported: readRequiredBoolean(
      runtimeInput,
      'inFlightSteerSupported',
      `${path}.runtimeInput`,
    ),
  };
}

function readAgentUiDescriptorExport(mod: Record<string, unknown>, descriptorPath: string): unknown {
  if ('AGENT_UI_DESCRIPTOR' in mod) return mod.AGENT_UI_DESCRIPTOR;
  if ('PLUGIN_UI_DESCRIPTOR' in mod) return mod.PLUGIN_UI_DESCRIPTOR;

  const descriptorExports = Object.entries(mod).filter(([name]) => name.endsWith('_UI_DESCRIPTOR'));
  if (descriptorExports.length === 1) {
    return descriptorExports[0]?.[1];
  }
  if (descriptorExports.length > 1) {
    throw new Error(`Expected one agent UI descriptor export in ${descriptorPath}, found ${descriptorExports.length}`);
  }
  throw new Error(`Expected AGENT_UI_DESCRIPTOR export in ${descriptorPath}`);
}

function normalizeAgentUiDescriptor(value: unknown, descriptorPath: string): AgentUiDescriptor {
  assertJsonSerializable(value);

  const root = readRequiredRecord(value, descriptorPath);
  if (root.projection !== undefined) {
    throw new Error(
      `Invalid agent UI descriptor at ${descriptorPath}.projection: projection import descriptors are not allowed; UI descriptors must be plugin.ui.v1 data-only envelopes`,
    );
  }
  const kind = readRequiredString(root, 'kind', descriptorPath);
  if (kind !== 'plugin.ui.v1') {
    throw new Error(`Invalid agent UI descriptor at ${descriptorPath}.kind: expected plugin.ui.v1`);
  }
  const display = readRequiredRecord(root.display, `${descriptorPath}.display`);
  const availability = readRequiredRecord(display.availability, `${descriptorPath}.display.availability`);
  const connectedService = readRequiredRecord(
    display.connectedService,
    `${descriptorPath}.display.connectedService`,
  );
  const permissions = readRequiredRecord(display.permissions, `${descriptorPath}.display.permissions`);
  const resume = readRequiredRecord(display.resume, `${descriptorPath}.display.resume`);
  const toolRendering = readRequiredRecord(display.toolRendering, `${descriptorPath}.display.toolRendering`);
  const picker = readRequiredRecord(display.picker, `${descriptorPath}.display.picker`);
  const avatarOverlay = readRequiredRecord(display.avatarOverlay, `${descriptorPath}.display.avatarOverlay`);
  const sessionModes = readOptionalAgentUiSessionModes(display, `${descriptorPath}.display`);
  const runtimeInput = readOptionalAgentUiRuntimeInput(display, `${descriptorPath}.display`);
  const icon = readOptionalJsonObjectDescriptor(display, 'icon', `${descriptorPath}.display`);
  const settings = readOptionalJsonObjectDescriptor(root, 'settings', descriptorPath);
  const behavior = readOptionalJsonObjectDescriptor(root, 'behavior', descriptorPath);
  const session = readOptionalJsonObjectDescriptor(root, 'session', descriptorPath);
  const message = readOptionalJsonObjectDescriptor(root, 'message', descriptorPath);
  const components = readOptionalJsonObjectDescriptor(root, 'components', descriptorPath);
  const assets = readOptionalJsonObjectDescriptor(root, 'assets', descriptorPath);

  return {
    kind,
    pluginId: readRequiredString(root, 'pluginId', descriptorPath),
    agentId: readRequiredString(root, 'agentId', descriptorPath),
    version: readRequiredNumber(root, 'version', descriptorPath),
    display: {
      nameKey: readRequiredString(display, 'nameKey', `${descriptorPath}.display`),
      subtitleKey: readRequiredString(display, 'subtitleKey', `${descriptorPath}.display`),
      permissionModeI18nPrefix: readRequiredString(display, 'permissionModeI18nPrefix', `${descriptorPath}.display`),
      availability: {
        experimental: readRequiredBoolean(availability, 'experimental', `${descriptorPath}.display.availability`),
      },
      connectedService: {
        serviceId: readNullableString(connectedService, 'serviceId', `${descriptorPath}.display.connectedService`),
        labelKey: readRequiredString(connectedService, 'labelKey', `${descriptorPath}.display.connectedService`),
        connectRoute: readNullableString(
          connectedService,
          'connectRoute',
          `${descriptorPath}.display.connectedService`,
        ),
      },
      flavorAliases: readStringArray(display, 'flavorAliases', `${descriptorPath}.display`),
      permissions: {
        modeGroup: readRequiredString(permissions, 'modeGroup', `${descriptorPath}.display.permissions`),
        promptProtocol: readRequiredString(permissions, 'promptProtocol', `${descriptorPath}.display.permissions`),
      },
      ...(sessionModes === undefined ? {} : { sessionModes }),
      ...(runtimeInput === undefined ? {} : { runtimeInput }),
      resume: {
        uiVendorResumeIdLabelKey: readNullableString(resume, 'uiVendorResumeIdLabelKey', `${descriptorPath}.display.resume`),
        uiVendorResumeIdCopiedKey: readNullableString(resume, 'uiVendorResumeIdCopiedKey', `${descriptorPath}.display.resume`),
      },
      ...(readOptionalBoolean(display, 'localControl', `${descriptorPath}.display`) === undefined
        ? {}
        : { localControl: readOptionalBoolean(display, 'localControl', `${descriptorPath}.display`) }),
      toolRendering: {
        hideUnknownToolsByDefault: readRequiredBoolean(
          toolRendering,
          'hideUnknownToolsByDefault',
          `${descriptorPath}.display.toolRendering`,
        ),
      },
      picker: {
        iconName: readRequiredString(picker, 'iconName', `${descriptorPath}.display.picker`),
        ...(readOptionalNumber(picker, 'iconScale', `${descriptorPath}.display.picker`) === undefined
          ? {}
          : { iconScale: readOptionalNumber(picker, 'iconScale', `${descriptorPath}.display.picker`) }),
        cliGlyphTokenId: readRequiredString(picker, 'cliGlyphTokenId', `${descriptorPath}.display.picker`),
        cliGlyphScale: readRequiredNumber(picker, 'cliGlyphScale', `${descriptorPath}.display.picker`),
        profileCompatibilityGlyphScale: readRequiredNumber(
          picker,
          'profileCompatibilityGlyphScale',
          `${descriptorPath}.display.picker`,
        ),
      },
      avatarOverlay: {
        circleScale: readRequiredNumber(avatarOverlay, 'circleScale', `${descriptorPath}.display.avatarOverlay`),
        iconScaleRatio: readRequiredNumber(avatarOverlay, 'iconScaleRatio', `${descriptorPath}.display.avatarOverlay`),
      },
      ...(icon === undefined ? {} : { icon: { assetId: readNullableString(icon, 'assetId', `${descriptorPath}.display.icon`) } }),
    },
    ...(settings === undefined ? {} : { settings }),
    ...(behavior === undefined ? {} : { behavior }),
    ...(session === undefined ? {} : { session }),
    ...(message === undefined ? {} : { message }),
    ...(components === undefined ? {} : { components }),
    ...(assets === undefined ? {} : { assets }),
  };
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

  return normalizeAgentDefinitionForAgentsOutput(definition);
}

function normalizeAgentDefinitionForAgentsOutput(definition: JsonValue): JsonValue {
  if (!isRecord(definition)) return definition;
  if (definition.providerCliRuntime !== undefined) {
    throw new Error('AGENT_DEFINITION.providerCliRuntime is no longer accepted for first-party bundled plugins; use agentCliRuntime');
  }
  const canonicalRuntime = definition.agentCliRuntime;
  if (canonicalRuntime === undefined) return definition;

  const {
    agentCliRuntime: _agentCliRuntime,
    ...rest
  } = definition;

  return {
    ...rest,
    agentCliRuntime: canonicalRuntime,
  };
}

function collectAgentCliRuntimeSpecSources(
  pluginPackages: readonly BundledPluginPackage[],
): readonly AgentCliRuntimeSpecSource[] {
  return pluginPackages.flatMap((entry) => {
    const definition = entry.agentDefinition;
    if (!isJsonObject(definition)) return [];

    const agentId = typeof definition.id === 'string' ? definition.id : entry.agentId;
    if (!agentId) return [];

    const runtimeSpec = definition.agentCliRuntime;
    if (runtimeSpec === undefined) return [];
    if (!isJsonObject(runtimeSpec)) {
      throw new Error(
        `Invalid AGENT_DEFINITION.agentCliRuntime for ${entry.pluginPackageId}: expected object`,
      );
    }
    if (runtimeSpec.id !== agentId) {
      throw new Error(
        `Invalid AGENT_DEFINITION.agentCliRuntime for ${entry.pluginPackageId}: runtime id must match agent id '${agentId}'`,
      );
    }

    return [{ agentId, runtimeSpec }];
  });
}

function readOptionalAgentCommandSurfaceSource(
  definition: JsonValue,
  pluginPackageId: string,
): AgentCommandSurfaceSource | undefined {
  const commandSurface = readJsonObjectProperty(definition, 'commandSurface');
  if (!commandSurface) return undefined;

  const rootHelpLabel = readOptionalJsonStringProperty(commandSurface, 'rootHelpLabel') ?? undefined;
  const rootHelpDescription = readOptionalJsonStringProperty(commandSurface, 'rootHelpDescription') ?? undefined;
  const rootHelpDetail = readOptionalJsonStringProperty(commandSurface, 'rootHelpDetail') ?? undefined;
  const allowTmux = commandSurface.allowTmux;
  if (allowTmux !== undefined && typeof allowTmux !== 'boolean') {
    throw new Error(
      `Invalid AGENT_DEFINITION.commandSurface for ${pluginPackageId}: allowTmux must be boolean when present`,
    );
  }

  if (
    rootHelpLabel === undefined
    && rootHelpDescription === undefined
    && rootHelpDetail === undefined
    && allowTmux === undefined
  ) {
    return undefined;
  }

  return {
    ...(rootHelpLabel === undefined ? {} : { rootHelpLabel }),
    ...(rootHelpDescription === undefined ? {} : { rootHelpDescription }),
    ...(rootHelpDetail === undefined ? {} : { rootHelpDetail }),
    ...(allowTmux === undefined ? {} : { allowTmux }),
  };
}

function collectAgentCommandSurfaceSources(
  pluginPackages: readonly BundledPluginPackage[],
): ReadonlyMap<string, AgentCommandSurfaceSource> {
  return new Map(
    pluginPackages.flatMap((entry) => {
      const definition = entry.agentDefinition;
      if (!isJsonObject(definition)) return [];

      const agentId = typeof definition.id === 'string' ? definition.id : entry.agentId;
      if (!agentId) return [];

      const commandSurface = readOptionalAgentCommandSurfaceSource(definition, entry.pluginPackageId);
      return commandSurface ? [[agentId, commandSurface] as const] : [];
    }),
  );
}

function collectBuiltInProviderContributionSources(
  pluginPackages: readonly BundledPluginPackage[],
): readonly BuiltInProviderContributionSource[] {
  const commandSurfaceByAgentId = collectAgentCommandSurfaceSources(pluginPackages);
  return getAllProviderDefinitionContracts().map((definition) => {
    const providerId = definition.id as AgentId;
    const richDefinition = getProviderDefinition(providerId);
    if (!richDefinition) {
      throw new Error(`Missing built-in provider catalog definition '${definition.id}'`);
    }
    return {
      id: definition.id,
      definition: readJsonSerializableValue(definition, `provider.${definition.id}.definition`),
      runtimeSpec: readJsonSerializableValue(
        getAgentCliRuntimeSpec(providerId),
        `provider.${definition.id}.runtimeSpec`,
      ),
      cliSubcommand: richDefinition.core.cliSubcommand,
      vendorResumeSupport: richDefinition.core.resume.vendorResume,
      ...(commandSurfaceByAgentId.has(definition.id)
        ? { commandSurface: commandSurfaceByAgentId.get(definition.id) }
        : {}),
    };
  });
}

function collectBuiltInBackendContributionSources(): readonly BuiltInBackendContributionSource[] {
  const backendCatalogDefinitionsById = new Map(
    getAllBackendDefinitions().map((definition) => [definition.id, definition] as const),
  );
  return getAllBackendDefinitionContracts().map((definition) => {
    const backendId = definition.id as AgentId;
    const richDefinition = backendCatalogDefinitionsById.get(backendId);
    if (!richDefinition) {
      throw new Error(`Missing built-in backend catalog definition '${definition.id}'`);
    }
    return {
      id: definition.id,
      providerId: definition.providerId,
      definition: readJsonSerializableValue(definition, `backend.${definition.id}.definition`),
      runtimeKind: richDefinition.engine?.defaultRuntimeKind ?? 'native',
    };
  });
}

async function loadPluginAgentUiDescriptor(
  repoRoot: string,
  pluginPackageId: string,
): Promise<AgentUiDescriptor | undefined> {
  const descriptorPath = resolve(repoRoot, 'packages/plugins', pluginPackageId, 'src/ui/descriptor.ts');
  if (!existsSync(descriptorPath)) return undefined;

  const mod = await importTypescriptModule(descriptorPath) as Record<string, unknown>;
  return normalizeAgentUiDescriptor(readAgentUiDescriptorExport(mod, descriptorPath), descriptorPath);
}

const PLUGIN_PROMPT_ASSET_EXPORT_NAME = 'PLUGIN_PROMPT_ASSET_DESCRIPTORS';

async function loadPluginPromptAssetContributions(
  repoRoot: string,
  pluginPackageId: string,
  packageName: string,
): Promise<PromptAssetContributionSource | undefined> {
  const contributionPath = resolve(repoRoot, 'packages/plugins', pluginPackageId, 'src/agent/promptAssets/index.ts');
  if (!existsSync(contributionPath)) return undefined;

  const mod = await importTypescriptModule(contributionPath) as Record<string, unknown>;
  const rawContributions = mod[PLUGIN_PROMPT_ASSET_EXPORT_NAME];
  if (!Array.isArray(rawContributions)) {
    throw new Error(
      `Expected ${PLUGIN_PROMPT_ASSET_EXPORT_NAME} array export in ${contributionPath}`,
    );
  }
  assertJsonSerializable(rawContributions);

  for (const [index, contribution] of rawContributions.entries()) {
    const parsed = PluginPromptAssetContributionV1Schema.safeParse(contribution);
    if (!parsed.success) {
      throw new Error(
        `Invalid prompt asset contribution ${pluginPackageId}[${index}]: ${parsed.error.message}`,
      );
    }
  }

  return {
    importName: `${toAgentConstPrefix(pluginPackageId)}_PROMPT_ASSET_DESCRIPTORS`,
    importPath: `${packageName}/agent/promptAssets`,
    pluginPackageId,
  };
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
    if (runtime.capabilities.some((capability) => capability === 'agents')) {
      return true;
    }
  }

  const contributes = manifest.contributes;
  if (!isRecord(contributes)) return false;
  if (Array.isArray(contributes.agents) && contributes.agents.length > 0) {
    return true;
  }
  if (!Array.isArray(contributes.backends)) {
    return false;
  }
  return contributes.backends.some((definition) => !isProviderlessReviewExecutionRunBackendContribution(definition as JsonValue));
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
    const explicitAgentRuntimeContributions = agentDefinition
      ? readOptionalAgentRuntimeContributions(agentDefinition, definitionPath)
      : undefined;
    const agentRuntimeContributions = explicitAgentRuntimeContributions
      ?? (agentDefinition
        ? await readConventionalAgentRuntimeContributions(repoRoot, pluginPackageId, agentDefinition.id)
        : undefined);
    const agentUiDescriptor = agentDefinition
      ? await loadPluginAgentUiDescriptor(repoRoot, pluginPackageId)
      : undefined;
    const promptAssetContributions = await loadPluginPromptAssetContributions(
      repoRoot,
      pluginPackageId,
      expectedPackageName,
    );
    if (agentRuntimeContributions?.providerCatalogEntry) {
      resolvePluginRuntimeProjectionSourceFile(
        repoRoot,
        pluginPackageId,
        agentRuntimeContributions.providerCatalogEntry.source,
      );
    }
    if (!agentDefinition && manifestDeclaresAgentRuntime(manifest)) {
      throw new Error(
        `Missing required agent definition for agent-capable plugin package ${pluginPackageId}: ${definitionPath}`,
      );
    }
    if (agentUiDescriptor && agentUiDescriptor.agentId !== agentDefinition?.id) {
      throw new Error(
        `Invalid agent UI descriptor for ${pluginPackageId}: descriptor agentId '${agentUiDescriptor.agentId}' does not match AGENT_DEFINITION.id '${String(agentDefinition?.id)}'`,
      );
    }

    out.push({
      pluginPackageId,
      pluginId: manifest.id,
      packageName: expectedPackageName,
      packageVersion: pkgJson.version,
      manifest,
      ...(agentDefinition ? { agentId: agentDefinition.id, agentDefinition } : {}),
      ...(agentUiDescriptor ? { agentUiDescriptor } : {}),
      ...(agentRuntimeContributions ? { agentRuntimeContributions } : {}),
      ...(promptAssetContributions ? { promptAssetContributions } : {}),
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
  lines.push('type BundledAgentDefinition = AgentDefinition;');
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
  lines.push('}) as const satisfies Readonly<Record<string, BundledAgentDefinition>>;');
  lines.push('');
  lines.push('export const BUNDLED_AGENT_DEFINITIONS_BY_ID = Object.freeze(_BUNDLED_AGENT_DEFINITIONS_BY_ID);');
  lines.push('');
  lines.push('// Canonical generated aggregate exports (avoid "*families*" naming).');
  lines.push('export const bundledAgentDefinitionIds = BUNDLED_AGENT_DEFINITION_IDS;');
  lines.push('export const bundledAgentDefinitions = BUNDLED_AGENT_DEFINITIONS_BY_ID;');
  lines.push('');
  return lines.join('\n');
}

function renderAgentProviderIdsTs(agentIds: readonly string[]): string {
  const lines: string[] = [];
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (A.X-agent-ids-codegen)');
  lines.push(' *');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`');
  lines.push(' *');
  lines.push(' * Agent provider ids are sourced from the built-in runtime catalog plus bundled plugin `AGENT_DEFINITION.id` values.');
  lines.push(' */');
  lines.push('');
  lines.push('export const AGENT_PROVIDER_IDS = Object.freeze([');
  for (const agentId of agentIds) {
    lines.push(`  ${renderTsStringLiteral(agentId)},`);
  }
  lines.push('] as const);');
  lines.push('');
  lines.push('export type AgentProviderId = (typeof AGENT_PROVIDER_IDS)[number];');
  lines.push('');
  lines.push('const AGENT_PROVIDER_ID_SET: ReadonlySet<string> = new Set(AGENT_PROVIDER_IDS);');
  lines.push('');
  lines.push('export function isAgentProviderId(value: unknown): value is AgentProviderId {');
  lines.push('  return typeof value === \'string\' && AGENT_PROVIDER_ID_SET.has(value);');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

function renderProtocolAgentProviderIdsV1Ts(agentIds: readonly string[]): string {
  const lines: string[] = [];
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (A.X-agent-ids-codegen)');
  lines.push(' *');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`');
  lines.push(' *');
  lines.push(' * This protocol-owned V1 wire schema intentionally preserves the existing');
  lines.push(' * daemon-facing provider id subset while deriving it from the generated');
  lines.push(' * bundled agent id source. Protocol cannot import `@happier-dev/agents`');
  lines.push(' * because that would create a package dependency cycle.');
  lines.push(' */');
  lines.push('');
  lines.push('import { z } from \'zod\';');
  lines.push('');
  lines.push('export const AGENT_PROVIDER_IDS_V1 = Object.freeze([');
  for (const agentId of agentIds) {
    lines.push(`  ${renderTsStringLiteral(agentId)},`);
  }
  lines.push('] as const);');
  lines.push('');
  lines.push('export type AgentProviderIdV1 = (typeof AGENT_PROVIDER_IDS_V1)[number];');
  lines.push('');
  lines.push('export const AgentProviderIdV1Schema = z.enum(AGENT_PROVIDER_IDS_V1);');
  lines.push('');
  return lines.join('\n');
}

function collectGeneratedAgentProviderIds(pluginAgentIds: readonly string[]): readonly string[] {
  const sourceIds = [
    ...Object.keys(CANONICAL_AGENTS_CORE),
    ...pluginAgentIds,
  ];
  const sourceIdSet = new Set(sourceIds);
  const out = STABLE_AGENT_PROVIDER_ID_ORDER.filter((agentId) => sourceIdSet.has(agentId));
  const seen = new Set<string>(out);
  for (const agentId of pluginAgentIds) {
    if (!seen.has(agentId)) {
      seen.add(agentId);
      out.push(agentId);
    }
  }
  for (const agentId of Object.keys(CANONICAL_AGENTS_CORE)) {
    if (!seen.has(agentId)) {
      seen.add(agentId);
      out.push(agentId);
    }
  }

  return out;
}

function collectProtocolAgentProviderIdsV1(agentProviderIds: readonly string[]): readonly string[] {
  const generatedIds = new Set(agentProviderIds);
  for (const agentId of PROTOCOL_AGENT_PROVIDER_IDS_V1) {
    if (!generatedIds.has(agentId)) {
      throw new Error(`Protocol AgentProviderIdV1 '${agentId}' is not present in generated agent provider ids`);
    }
  }
  return PROTOCOL_AGENT_PROVIDER_IDS_V1;
}

function collectSessionControlAdapterContributions(
  pluginPackages: readonly BundledPluginPackage[],
): readonly SessionControlAdapterProjectionDescriptor[] {
  return pluginPackages
    .flatMap((entry): SessionControlAdapterProjectionDescriptor[] => {
      const contribution = entry.agentRuntimeContributions?.sessionControlAdapter;
      if (!contribution) return [];
      if (contribution.kind === 'providerSessionControlAdapter') {
        return [{
          ...contribution,
          source: `${entry.packageName}/${normalizePluginRuntimeProjectionSource(contribution.source)}`,
        }];
      }
      return [contribution];
    })
    .sort((a, b) => a.providerId.localeCompare(b.providerId));
}

function collectRuntimeDescriptorReaderContributions(
  pluginPackages: readonly BundledPluginPackage[],
): readonly RuntimeDescriptorReaderProjectionDescriptor[] {
  return pluginPackages
    .flatMap((entry): RuntimeDescriptorReaderProjectionDescriptor[] => {
      const contribution = entry.agentRuntimeContributions?.runtimeDescriptorReader;
      if (!contribution) return [];
      if (contribution.kind === 'providerRuntimeDescriptorReader') {
        return [{
          ...contribution,
          source: `${entry.packageName}/${normalizePluginRuntimeProjectionSource(contribution.source)}`,
        }];
      }
      return [contribution];
    })
    .sort((a, b) => a.providerId.localeCompare(b.providerId));
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function assertExportedRuntimeDescriptorSymbol(
  sourceContent: string,
  symbolName: string,
  sourcePath: string,
): void {
  const escaped = escapeRegExp(symbolName);
  const exportedSymbolPattern = new RegExp(
    `export\\s+(?:async\\s+)?(?:function|const|type|interface)\\s+${escaped}\\b`,
  );
  if (!exportedSymbolPattern.test(sourceContent)) {
    throw new Error(`Invalid protocol runtime descriptor source ${sourcePath}: missing exported ${symbolName}`);
  }
}

function assertHermeticProtocolRuntimeDescriptorSource(
  sourceContent: string,
  sourcePath: string,
): void {
  const importSpecifierPatterns = [
    /^\s*(?:import|export)\s+[^'"]*\sfrom\s+['"]([^'"]+)['"]/gm,
    /^\s*import\s+['"]([^'"]+)['"]/gm,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gm,
  ];
  for (const pattern of importSpecifierPatterns) {
    for (const match of sourceContent.matchAll(pattern)) {
      assertHermeticProtocolRuntimeDescriptorImportSpecifier(match[1], sourcePath);
    }
  }
}

function assertHermeticProtocolRuntimeDescriptorImportSpecifier(
  specifier: string,
  sourcePath: string,
): void {
  if (specifier.startsWith('.')) {
    throw new Error(
      `Invalid protocol runtime descriptor source ${sourcePath}: generated protocol modules cannot preserve relative imports`,
    );
  }
  if (
    specifier === '@happier-dev/protocol'
    || specifier.startsWith('@happier-dev/plugins-')
    || specifier.startsWith('@/')
    || specifier.includes('packages/plugins/')
  ) {
    throw new Error(
      `Invalid protocol runtime descriptor source ${sourcePath}: generated protocol module would import forbidden ${specifier}`,
    );
  }
}

function protocolRuntimeDescriptorModuleFileName(providerId: string): string {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(providerId)) {
    throw new Error(`Invalid protocol runtime descriptor provider id '${providerId}': cannot derive generated module filename`);
  }
  return `${providerId}.ts`;
}

function renderGeneratedProtocolRuntimeDescriptorModuleTs(
  contribution: ProtocolRuntimeDescriptorProjectionDescriptor,
): string {
  const lines: string[] = [];
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (A.16y.6-runtime-descriptor-protocol-abi-codegen)');
  lines.push(' *');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`');
  lines.push(' */');
  lines.push('');
  lines.push(contribution.sourceContent.trimEnd());
  lines.push('');
  return lines.join('\n');
}

function collectProtocolRuntimeDescriptorContributions(
  pluginPackages: readonly BundledPluginPackage[],
  repoRoot: string,
): readonly ProtocolRuntimeDescriptorProjectionDescriptor[] {
  return pluginPackages
    .flatMap((entry): ProtocolRuntimeDescriptorProjectionDescriptor[] => {
      const contribution = entry.agentRuntimeContributions?.protocolRuntimeDescriptor;
      if (!contribution) return [];
      const sourceFilePath = resolvePluginRuntimeProjectionSourceFile(repoRoot, entry.pluginPackageId, contribution.source);
      const sourceContent = readFileSync(sourceFilePath, 'utf8');
      const descriptorType = runtimeDescriptorTypeFromBuildFunction(contribution.buildFunction);
      const canonicalType = canonicalRuntimeDescriptorTypeFromReader(contribution.canonicalReader);
      assertExportedRuntimeDescriptorSymbol(sourceContent, contribution.buildFunction, sourceFilePath);
      assertExportedRuntimeDescriptorSymbol(sourceContent, contribution.canonicalReader, sourceFilePath);
      assertExportedRuntimeDescriptorSymbol(sourceContent, descriptorType, sourceFilePath);
      assertExportedRuntimeDescriptorSymbol(sourceContent, canonicalType, sourceFilePath);
      assertHermeticProtocolRuntimeDescriptorSource(sourceContent, sourceFilePath);
      const moduleFileName = protocolRuntimeDescriptorModuleFileName(contribution.providerId);
      return [{
        ...contribution,
        generatedImportSource: `./generated/runtime/descriptors/${moduleFileName.replace(/\.ts$/, '')}`,
        moduleFileName,
        sourceContent,
      }];
    })
    .sort((a, b) => a.providerId.localeCompare(b.providerId));
}

function compareStableProviderIdOrder(a: string, b: string): number {
  const ai = STABLE_AGENT_PROVIDER_ID_ORDER.indexOf(a as (typeof STABLE_AGENT_PROVIDER_ID_ORDER)[number]);
  const bi = STABLE_AGENT_PROVIDER_ID_ORDER.indexOf(b as (typeof STABLE_AGENT_PROVIDER_ID_ORDER)[number]);
  if (ai !== -1 || bi !== -1) {
    return (ai === -1 ? Number.MAX_SAFE_INTEGER : ai) - (bi === -1 ? Number.MAX_SAFE_INTEGER : bi);
  }
  return a.localeCompare(b);
}

async function readPluginProtocolProjectionExport(
  repoRoot: string,
  entry: BundledPluginPackage,
  contribution: Readonly<{ source: string; exportName: string }>,
): Promise<JsonValue> {
  const sourceFilePath = resolvePluginRuntimeProjectionSourceFile(repoRoot, entry.pluginPackageId, contribution.source);
  const mod = await importTypescriptModule(sourceFilePath) as Record<string, unknown>;
  if (!(contribution.exportName in mod)) {
    throw new Error(`Expected ${contribution.exportName} export in ${sourceFilePath}`);
  }
  return readJsonSerializableValue(mod[contribution.exportName], `${sourceFilePath}.${contribution.exportName}`);
}

async function collectProtocolBuiltInBackendProfilesContributions(
  pluginPackages: readonly BundledPluginPackage[],
  repoRoot: string,
): Promise<readonly ProtocolBuiltInBackendProfilesProjectionDescriptor[]> {
  const out: ProtocolBuiltInBackendProfilesProjectionDescriptor[] = [];
  for (const entry of pluginPackages) {
    const contribution = entry.agentRuntimeContributions?.protocolBuiltInBackendProfiles;
    if (!contribution) continue;
    const rawProfiles = await readPluginProtocolProjectionExport(repoRoot, entry, contribution);
    if (!Array.isArray(rawProfiles)) {
      throw new Error(`Invalid protocol built-in backend profiles source for ${entry.pluginPackageId}: expected array`);
    }
    const profiles = rawProfiles.map((profile, index): JsonObject => {
      const normalized = readJsonSerializableValue(
        profile,
        `${entry.pluginPackageId}.${contribution.exportName}[${String(index)}]`,
      );
      if (!isJsonObject(normalized) || typeof normalized.id !== 'string' || normalized.id.trim().length === 0) {
        throw new Error(
          `Invalid protocol built-in backend profile ${entry.pluginPackageId}.${contribution.exportName}[${String(index)}]: expected object with id`,
        );
      }
      return normalized;
    });
    out.push({ ...contribution, profiles });
  }
  out.sort((a, b) => compareStableProviderIdOrder(a.providerId, b.providerId));
  return out;
}

async function collectProtocolMemoryDefaultsContributions(
  pluginPackages: readonly BundledPluginPackage[],
  repoRoot: string,
): Promise<readonly ProtocolMemoryDefaultsProjectionDescriptor[]> {
  const out: ProtocolMemoryDefaultsProjectionDescriptor[] = [];
  for (const entry of pluginPackages) {
    const contribution = entry.agentRuntimeContributions?.protocolMemoryDefaults;
    if (!contribution) continue;
    const rawDefaults = await readPluginProtocolProjectionExport(repoRoot, entry, contribution);
    const defaults = readRequiredRecord(rawDefaults, `${entry.pluginPackageId}.${contribution.exportName}`);
    out.push({
      ...contribution,
      summarizerBackendId: readRequiredString(defaults, 'summarizerBackendId', `${entry.pluginPackageId}.${contribution.exportName}`),
    });
  }
  out.sort((a, b) => compareStableProviderIdOrder(a.providerId, b.providerId));
  return out;
}

function readExternalSessionWhenDescriptor(value: unknown, path: string): Readonly<{ field: string; equals: string }> {
  const record = readRequiredRecord(value, path);
  return {
    field: readRequiredString(record, 'field', path),
    equals: readRequiredString(record, 'equals', path),
  };
}

function readExternalSessionSchemaFieldDescriptor(value: unknown, path: string): ExternalSessionSchemaFieldDescriptor {
  const record = readRequiredRecord(value, path);
  const kind = readRequiredString(record, 'kind', path);
  const base = {
    name: readRequiredString(record, 'name', path),
    optional: readOptionalBoolean(record, 'optional', path),
    nullish: readOptionalBoolean(record, 'nullish', path),
    min: readOptionalNumber(record, 'min', path),
    max: readOptionalNumber(record, 'max', path),
  };
  if (kind === 'literal') {
    return {
      ...base,
      kind,
      value: readRequiredString(record, 'value', path),
    };
  }
  if (kind === 'enum') {
    return {
      ...base,
      kind,
      values: readStringArray(record, 'values', path),
    };
  }
  if (kind === 'string' || kind === 'unknown') {
    return { ...base, kind };
  }
  throw new Error(`Invalid external-session source declaration at ${path}.kind: expected literal, string, enum, or unknown`);
}

function readExternalSessionSchemaRefinementDescriptor(value: unknown, path: string): ExternalSessionSchemaRefinementDescriptor {
  const record = readRequiredRecord(value, path);
  const kind = readRequiredString(record, 'kind', path);
  if (kind === 'requiresWhenEquals') {
    return {
      kind,
      field: readRequiredString(record, 'field', path),
      when: readExternalSessionWhenDescriptor(record.when, `${path}.when`),
    };
  }
  if (kind === 'forbidsWhenEquals') {
    return {
      kind,
      fields: readStringArray(record, 'fields', path),
      when: readExternalSessionWhenDescriptor(record.when, `${path}.when`),
    };
  }
  throw new Error(`Invalid external-session source declaration at ${path}.kind: expected requiresWhenEquals or forbidsWhenEquals`);
}

function readExternalSessionKeySegmentDescriptor(value: unknown, path: string): ExternalSessionKeySegmentDescriptor {
  const record = readRequiredRecord(value, path);
  const kind = readRequiredString(record, 'kind', path);
  if (kind === 'literal') {
    return { kind, value: readRequiredString(record, 'value', path) };
  }
  if (kind === 'field') {
    return { kind, field: readRequiredString(record, 'field', path) };
  }
  if (kind === 'homeMode') {
    return { kind, field: readRequiredString(record, 'field', path) };
  }
  if (kind === 'conditionalField') {
    return {
      kind,
      field: readRequiredString(record, 'field', path),
      when: readExternalSessionWhenDescriptor(record.when, `${path}.when`),
    };
  }
  if (kind === 'connectedServiceScope') {
    return {
      kind,
      groupField: readRequiredString(record, 'groupField', path),
      profileField: readRequiredString(record, 'profileField', path),
      when: readExternalSessionWhenDescriptor(record.when, `${path}.when`),
    };
  }
  throw new Error(
    `Invalid external-session source declaration at ${path}.kind: expected literal, field, homeMode, conditionalField, or connectedServiceScope`,
  );
}

function readExternalSessionSourceDeclaration(value: JsonValue, path: string): ExternalSessionSourceDeclaration {
  const record = readRequiredRecord(value, path);
  const schema = readRequiredRecord(record.schema, `${path}.schema`);
  const fields = schema.fields;
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error(`Invalid external-session source declaration at ${path}.schema.fields: expected non-empty array`);
  }
  const refinements = schema.refinements;
  const key = readRequiredRecord(record.key, `${path}.key`);
  const segments = key.segments;
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error(`Invalid external-session source declaration at ${path}.key.segments: expected non-empty array`);
  }
  return {
    providerId: readRequiredString(record, 'providerId', path),
    sourceKind: readRequiredString(record, 'sourceKind', path),
    schema: {
      passthrough: readOptionalBoolean(schema, 'passthrough', `${path}.schema`),
      fields: fields.map((field, index) => readExternalSessionSchemaFieldDescriptor(field, `${path}.schema.fields[${String(index)}]`)),
      ...(refinements === undefined
        ? {}
        : {
          refinements: Array.isArray(refinements)
            ? refinements.map((refinement, index) => readExternalSessionSchemaRefinementDescriptor(
              refinement,
              `${path}.schema.refinements[${String(index)}]`,
            ))
            : (() => {
              throw new Error(`Invalid external-session source declaration at ${path}.schema.refinements: expected array`);
            })(),
        }),
    },
    key: {
      segments: segments.map((segment, index) => readExternalSessionKeySegmentDescriptor(segment, `${path}.key.segments[${String(index)}]`)),
    },
  };
}

async function collectProtocolExternalSessionSourceContributions(
  pluginPackages: readonly BundledPluginPackage[],
  repoRoot: string,
): Promise<readonly ProtocolExternalSessionSourceProjectionDescriptor[]> {
  const out: ProtocolExternalSessionSourceProjectionDescriptor[] = [];
  for (const entry of pluginPackages) {
    const contribution = entry.agentRuntimeContributions?.protocolExternalSessionSource;
    if (!contribution) continue;
    const rawDeclaration = await readPluginProtocolProjectionExport(repoRoot, entry, contribution);
    const declaration = readExternalSessionSourceDeclaration(
      rawDeclaration,
      `${entry.pluginPackageId}.${contribution.exportName}`,
    );
    if (declaration.providerId !== contribution.providerId) {
      throw new Error(
        `Invalid external-session source declaration for ${entry.pluginPackageId}: providerId '${declaration.providerId}' does not match contribution providerId '${contribution.providerId}'`,
      );
    }
    out.push({
      ...contribution,
      declaration,
    });
  }
  out.sort((a, b) => compareStableProviderIdOrder(a.providerId, b.providerId));
  return out;
}

const RUNTIME_CONTRIBUTION_PROJECTION_CONTRACT = 'A.16y.3-provider-session-control-and-runtime-descriptor-projections';
const PROTOCOL_RUNTIME_DESCRIPTOR_ABI_CODEGEN_CONTRACT = 'A.16y.6-runtime-descriptor-protocol-abi-codegen';
const PROTOCOL_PROVIDER_DEFAULT_SOURCE_PROJECTION_CONTRACT = 'A.16y.7-protocol-provider-default-and-source-projection';

function renderRuntimeContributionProjectionHeader(
  lines: string[],
  extraContracts: readonly string[] = [],
): void {
  lines.push('/**');
  lines.push(` * GENERATED FILE CONTRACT (${RUNTIME_CONTRIBUTION_PROJECTION_CONTRACT})`);
  for (const contract of extraContracts) {
    lines.push(` * GENERATED FILE CONTRACT (${contract})`);
  }
  lines.push(' *');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`');
  lines.push(' */');
}

function renderProtocolProviderProjectionHeader(lines: string[]): void {
  lines.push('/**');
  lines.push(` * GENERATED FILE CONTRACT (${PROTOCOL_PROVIDER_DEFAULT_SOURCE_PROJECTION_CONTRACT})`);
  lines.push(' *');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`');
  lines.push(' */');
}

function renderGeneratedBuiltInBackendProfilesTs(
  contributions: readonly ProtocolBuiltInBackendProfilesProjectionDescriptor[],
): string {
  const profiles = contributions.flatMap((contribution) => contribution.profiles);
  const lines: string[] = [];
  renderProtocolProviderProjectionHeader(lines);
  lines.push('');
  lines.push('import type { AIBackendProfile } from \'../../../profiles/backendProfileSchema.js\';');
  lines.push('');
  lines.push('export const GENERATED_BUILT_IN_BACKEND_PROFILES = [');
  for (const profile of profiles) {
    lines.push(`${renderJsonLiteral(profile, 2).split('\n').map((line) => `  ${line}`).join('\n')},`);
  }
  lines.push('] as const satisfies ReadonlyArray<AIBackendProfile>;');
  lines.push('');
  return lines.join('\n');
}

function renderGeneratedMemoryDefaultsTs(
  contributions: readonly ProtocolMemoryDefaultsProjectionDescriptor[],
): string {
  if (contributions.length > 1) {
    throw new Error(`Expected at most one generated protocol memory default contribution, found ${String(contributions.length)}`);
  }
  const defaults = contributions[0];
  const lines: string[] = [];
  renderProtocolProviderProjectionHeader(lines);
  lines.push('');
  lines.push(`export const GENERATED_MEMORY_SUMMARIZER_BACKEND_ID = ${
    defaults ? renderTsStringLiteral(defaults.summarizerBackendId) : 'null'
  } as const;`);
  lines.push('');
  lines.push('export const GENERATED_MEMORY_DEFAULTS = Object.freeze({');
  lines.push('  summarizerBackendId: GENERATED_MEMORY_SUMMARIZER_BACKEND_ID,');
  lines.push('} as const);');
  lines.push('');
  return lines.join('\n');
}

function renderGeneratedExternalSessionSourcesTs(
  contributions: readonly ProtocolExternalSessionSourceProjectionDescriptor[],
): string {
  const lines: string[] = [];
  renderProtocolProviderProjectionHeader(lines);
  lines.push('');
  lines.push('export const GENERATED_EXTERNAL_SESSIONS_SOURCE_DECLARATIONS = [');
  for (const contribution of contributions) {
    lines.push(`${renderJsonLiteral(contribution.declaration, 2).split('\n').map((line) => `  ${line}`).join('\n')},`);
  }
  lines.push('] as const;');
  lines.push('');
  return lines.join('\n');
}

function renderAgentSessionControlAdaptersTs(
  contributions: readonly SessionControlAdapterProjectionDescriptor[],
): string {
  const lines: string[] = [];
  renderRuntimeContributionProjectionHeader(lines);
  lines.push('');
  const dataOnlyContributions = contributions.filter(
    (contribution): contribution is RuntimeDescriptorResumeIdSessionControlContributionDescriptor =>
      contribution.kind === 'runtimeDescriptorResumeId',
  );
  const executableContributions = contributions.filter(
    (contribution): contribution is ProviderSessionControlAdapterContributionDescriptor =>
      contribution.kind === 'providerSessionControlAdapter',
  );
  if (dataOnlyContributions.length > 0) {
    lines.push('import {');
    lines.push('  createRuntimeDescriptorResumeIdSessionControlAdapter,');
    lines.push('} from \'../runtime/controlSurface/runtimeDescriptorResume.js\';');
  }
  for (const contribution of executableContributions) {
    lines.push(
      `import { ${contribution.exportName} } from ${renderTsStringLiteral(`../providers/${contribution.providerId}/sessionControlAdapter.js`)};`,
    );
  }
  lines.push('import type { ProviderSessionControlAdapter } from \'../runtime/controlSurface/types.js\';');
  lines.push('');
  lines.push('export const GENERATED_PROVIDER_SESSION_CONTROL_ADAPTER_PROVIDER_IDS = [');
  for (const contribution of contributions) {
    lines.push(`  ${renderTsStringLiteral(contribution.providerId)},`);
  }
  lines.push('] as const;');
  lines.push('');
  lines.push('export type GeneratedProviderSessionControlAdapterProviderId =');
  lines.push('  (typeof GENERATED_PROVIDER_SESSION_CONTROL_ADAPTER_PROVIDER_IDS)[number];');
  lines.push('');
  lines.push('export const GENERATED_PROVIDER_SESSION_CONTROL_ADAPTERS: Readonly<Record<GeneratedProviderSessionControlAdapterProviderId, ProviderSessionControlAdapter>> = Object.freeze({');
  for (const contribution of contributions) {
    if (contribution.kind === 'providerSessionControlAdapter') {
      lines.push(`  ${contribution.providerId}: ${contribution.exportName},`);
    } else {
      lines.push(`  ${contribution.providerId}: createRuntimeDescriptorResumeIdSessionControlAdapter({`);
      lines.push(`    providerId: ${renderTsStringLiteral(contribution.providerId)},`);
      if (contribution.absolutePathField) {
        lines.push(`    absolutePathField: ${renderTsStringLiteral(contribution.absolutePathField)},`);
      }
      lines.push(`    fallbackField: ${renderTsStringLiteral(contribution.fallbackField)},`);
      lines.push('  }),');
    }
  }
  lines.push('});');
  lines.push('');
  return lines.join('\n');
}

function renderAgentRuntimeDescriptorReadersTs(
  contributions: readonly RuntimeDescriptorReaderProjectionDescriptor[],
): string {
  const lines: string[] = [];
  renderRuntimeContributionProjectionHeader(lines);
  lines.push('');
  const dataOnlyContributions = contributions.filter(
    (contribution): contribution is ProviderSessionIdRuntimeDescriptorReaderContributionDescriptor =>
      contribution.kind === 'providerSessionId',
  );
  const executableContributions = contributions.filter(
    (contribution): contribution is ProviderRuntimeDescriptorReaderContributionDescriptor =>
      contribution.kind === 'providerRuntimeDescriptorReader',
  );
  if (dataOnlyContributions.length > 0) {
    lines.push('import {');
    lines.push('  createProviderSessionIdRuntimeDescriptorReader,');
    lines.push('} from \'../runtime/identity/providerSessionIdReader.js\';');
  }
  for (const contribution of executableContributions) {
    lines.push(
      `import { ${contribution.exportName} } from ${renderTsStringLiteral(`../providers/${contribution.providerId}/readSessionMetadataRuntimeDescriptor.js`)};`,
    );
  }
  lines.push('import type { RuntimeDescriptorReaderMap } from \'../runtime/identity/runtimeDescriptorTypes.js\';');
  lines.push('');
  lines.push('export const GENERATED_RUNTIME_DESCRIPTOR_READER_PROVIDER_IDS = [');
  for (const contribution of contributions) {
    lines.push(`  ${renderTsStringLiteral(contribution.providerId)},`);
  }
  lines.push('] as const;');
  lines.push('');
  lines.push('export type GeneratedRuntimeDescriptorReaderProviderId =');
  lines.push('  (typeof GENERATED_RUNTIME_DESCRIPTOR_READER_PROVIDER_IDS)[number];');
  lines.push('');
  lines.push('export const GENERATED_RUNTIME_DESCRIPTOR_READERS: Readonly<Pick<RuntimeDescriptorReaderMap, GeneratedRuntimeDescriptorReaderProviderId>> = Object.freeze({');
  for (const contribution of contributions) {
    if (contribution.kind === 'providerRuntimeDescriptorReader') {
      lines.push(`  ${contribution.providerId}: ${contribution.exportName},`);
    } else {
      lines.push(`  ${contribution.providerId}: createProviderSessionIdRuntimeDescriptorReader({`);
      lines.push(`    providerId: ${renderTsStringLiteral(contribution.providerId)},`);
      lines.push(`    runtimeHandle: ${renderTsStringLiteral(contribution.runtimeHandle)},`);
      lines.push('  }),');
    }
  }
  lines.push('});');
  lines.push('');
  return lines.join('\n');
}

function runtimeDescriptorTypeFromBuildFunction(buildFunction: string): string {
  if (!buildFunction.startsWith('build')) {
    throw new Error(`Invalid runtime descriptor build function '${buildFunction}': expected build*`);
  }
  return buildFunction.slice('build'.length);
}

function canonicalRuntimeDescriptorTypeFromReader(canonicalReader: string): string {
  if (!canonicalReader.startsWith('readCanonical')) {
    throw new Error(`Invalid canonical runtime descriptor reader '${canonicalReader}': expected readCanonical*`);
  }
  return canonicalReader.slice('read'.length);
}

function renderProtocolRuntimeDescriptorContributionsV1Ts(
  contributions: readonly ProtocolRuntimeDescriptorProjectionDescriptor[],
): string {
  const lines: string[] = [];
  renderRuntimeContributionProjectionHeader(lines, [PROTOCOL_RUNTIME_DESCRIPTOR_ABI_CODEGEN_CONTRACT]);
  lines.push('');
  for (const contribution of contributions) {
    const descriptorType = runtimeDescriptorTypeFromBuildFunction(contribution.buildFunction);
    const canonicalType = canonicalRuntimeDescriptorTypeFromReader(contribution.canonicalReader);
    lines.push('import {');
    lines.push(`  ${contribution.buildFunction},`);
    lines.push(`  ${contribution.canonicalReader},`);
    lines.push(`  type ${canonicalType},`);
    lines.push(`  type ${descriptorType},`);
    lines.push(`} from ${renderTsStringLiteral(renderTsImportSpecifier(contribution.generatedImportSource))};`);
  }
  lines.push('');
  lines.push('export {');
  for (const contribution of contributions) {
    lines.push(`  ${contribution.buildFunction},`);
  }
  lines.push('};');
  lines.push('');
  lines.push('export type {');
  for (const contribution of contributions) {
    lines.push(`  ${canonicalRuntimeDescriptorTypeFromReader(contribution.canonicalReader)},`);
    lines.push(`  ${runtimeDescriptorTypeFromBuildFunction(contribution.buildFunction)},`);
  }
  lines.push('};');
  lines.push('');
  lines.push('export const GENERATED_RUNTIME_DESCRIPTOR_PROVIDER_IDS_V1 = [');
  for (const contribution of contributions) {
    lines.push(`  ${renderTsStringLiteral(contribution.providerId)},`);
  }
  lines.push('] as const;');
  lines.push('');
  lines.push('export type GeneratedRuntimeDescriptorProviderIdV1 =');
  lines.push('  (typeof GENERATED_RUNTIME_DESCRIPTOR_PROVIDER_IDS_V1)[number];');
  lines.push('');
  lines.push('export type GeneratedRuntimeDescriptorByProviderIdV1 = {');
  for (const contribution of contributions) {
    lines.push(`  ${contribution.providerId}: ${runtimeDescriptorTypeFromBuildFunction(contribution.buildFunction)};`);
  }
  lines.push('};');
  lines.push('');
  lines.push('export type GeneratedCanonicalRuntimeDescriptorByProviderIdV1 = {');
  for (const contribution of contributions) {
    lines.push(`  ${contribution.providerId}: ${canonicalRuntimeDescriptorTypeFromReader(contribution.canonicalReader)};`);
  }
  lines.push('};');
  lines.push('');
  lines.push('type GeneratedRuntimeDescriptorContributionV1 = Readonly<{');
  lines.push('  providerId: GeneratedRuntimeDescriptorProviderIdV1;');
  lines.push('  readCanonicalDescriptor: (descriptor: unknown) => unknown;');
  lines.push('}>;');
  lines.push('');
  lines.push('export const GENERATED_RUNTIME_DESCRIPTOR_CONTRIBUTIONS_V1 = Object.freeze({');
  for (const contribution of contributions) {
    const descriptorType = runtimeDescriptorTypeFromBuildFunction(contribution.buildFunction);
    lines.push(`  ${contribution.providerId}: Object.freeze({`);
    lines.push(`    providerId: ${renderTsStringLiteral(contribution.providerId)},`);
    lines.push(`    readCanonicalDescriptor: (descriptor: unknown) => ${contribution.canonicalReader}(`);
    lines.push(`      descriptor as ${descriptorType} | null,`);
    lines.push('    ),');
    lines.push('  }),');
  }
  lines.push('} satisfies {');
  lines.push('  readonly [K in GeneratedRuntimeDescriptorProviderIdV1]: GeneratedRuntimeDescriptorContributionV1;');
  lines.push('});');
  lines.push('');
  lines.push('export function getGeneratedRuntimeDescriptorContributionV1<TProviderId extends GeneratedRuntimeDescriptorProviderIdV1>(');
  lines.push('  providerId: TProviderId,');
  lines.push('): GeneratedRuntimeDescriptorContributionV1;');
  lines.push('export function getGeneratedRuntimeDescriptorContributionV1(');
  lines.push('  providerId: string,');
  lines.push('): GeneratedRuntimeDescriptorContributionV1 | null;');
  lines.push('export function getGeneratedRuntimeDescriptorContributionV1(');
  lines.push('  providerId: string,');
  lines.push('): GeneratedRuntimeDescriptorContributionV1 | null {');
  lines.push('  return Object.hasOwn(GENERATED_RUNTIME_DESCRIPTOR_CONTRIBUTIONS_V1, providerId)');
  lines.push('    ? GENERATED_RUNTIME_DESCRIPTOR_CONTRIBUTIONS_V1[providerId as GeneratedRuntimeDescriptorProviderIdV1]');
  lines.push('    : null;');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

function renderCliBundledPluginEntriesTs(params: Readonly<{
  pluginPackages: readonly BundledPluginPackage[];
}>): string {
  const providerCatalogEntryHookSources = collectProviderCatalogEntryHookSources(params.pluginPackages);
  const builtInProviderContributionSources = collectBuiltInProviderContributionSources(params.pluginPackages);
  const builtInBackendContributionSources = collectBuiltInBackendContributionSources();
  const agentCliRuntimeSpecSourcesById = new Map<string, JsonValue>(
    builtInProviderContributionSources.map((source) => [source.id, source.runtimeSpec] as const),
  );
  for (const source of collectAgentCliRuntimeSpecSources(params.pluginPackages)) {
    agentCliRuntimeSpecSourcesById.set(source.agentId, source.runtimeSpec);
  }
  const agentCliRuntimeSpecSources = [...agentCliRuntimeSpecSourcesById.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([agentId, runtimeSpec]) => ({ agentId, runtimeSpec }));
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
  const agentBackendContributions = params.pluginPackages.flatMap((entry) => (
    readManifestContributionArray(entry.manifest, 'backends')
      .map((definition): BundledManifestContribution & Readonly<{ agentId: string }> => {
        const contributionId = readRequiredContributionId(definition, 'backends', entry.pluginPackageId);
        const agentId = readRequiredContributionString(definition, 'agentId', 'backends', entry.pluginPackageId);
        const contributionMetadata = metadataByPluginPackageId.get(entry.pluginPackageId);
        if (!contributionMetadata) {
          throw new Error(`Missing bundled plugin metadata for ${entry.pluginPackageId}`);
        }
        return {
          id: contributionId,
          agentId,
          definition,
          metadata: contributionMetadata,
        };
      })
  ));
  const reviewBackendContributions = agentBackendContributions.filter((contribution) =>
    isProviderlessReviewExecutionRunBackendContribution(contribution.definition)
  );
  const agentBackendSurfaceHandlerContributions = agentBackendContributions.filter((contribution) =>
    !isProviderlessReviewExecutionRunBackendContribution(contribution.definition)
    && readJsonArrayProperty(contribution.definition, 'surfaceHandlers').length > 0
  );
  const agentBackendSurfaceHandlerIds = new Set<string>();
  for (const contribution of agentBackendSurfaceHandlerContributions) {
    if (agentBackendSurfaceHandlerIds.has(contribution.id)) {
      throw new Error(`Duplicate bundled agent backend surface handler contribution '${contribution.id}'`);
    }
    agentBackendSurfaceHandlerIds.add(contribution.id);
  }
  const executionRunProfileContributions = params.pluginPackages.flatMap((entry) => (
    readManifestContributionArray(entry.manifest, 'executionRunProfiles').map((definition): BundledManifestContribution => {
      const contributionId = readRequiredContributionId(definition, 'executionRunProfiles', entry.pluginPackageId);
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
  lines.push(' * Runtime reads this local artifact; bundled plugin packages are locator metadata except');
  lines.push(' * for narrow runtime contribution subpath imports.');
  lines.push(' */');
  lines.push('');
  lines.push('import type { ProviderCliRuntimeDescriptor } from \'@happier-dev/cli-common/providers\';');
  lines.push('import type { CommandHandler } from \'@/cli/commandRegistry\';');
  if (providerCatalogEntryHookSources.length > 0) {
    lines.push('import { createProviderRuntimeCatalogEntryHooks } from \'../providerCatalogEntryHooks\';');
  }
  for (const source of providerCatalogEntryHookSources) {
    lines.push(`import { ${source.importName} } from ${renderTsStringLiteral(source.importPath)};`);
  }
  const externalSessionHostAdapterImportSources = providerCatalogEntryHookSources.flatMap((source) => [
    source.externalSessionHostAdapters?.candidateHostAdapter,
    source.externalSessionHostAdapters?.transcriptStoreAdapter,
  ].filter((entry): entry is ExternalSessionHostAdapterImportSource => Boolean(entry)));
  for (const source of externalSessionHostAdapterImportSources) {
    lines.push(`import { ${source.exportName} as ${source.importAlias} } from ${renderTsStringLiteral(source.importPath)};`);
  }
  lines.push('');
  lines.push('import type {');
  lines.push('  ResolvedActivationTarget,');
  lines.push('  ResolvedBackendContribution,');
  lines.push('  ResolvedCatalogEntry,');
  lines.push('  ResolvedConnectedAccountDescriptorContribution,');
  lines.push('  ResolvedInstallableContribution,');
  lines.push('  ResolvedExecutionRunProfileContribution,');
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
  lines.push('export const BUNDLED_FIRST_PARTY_AGENT_CLI_RUNTIME_SPECS_BY_ID: Readonly<Record<string, ProviderCliRuntimeDescriptor>> = Object.freeze({');
  for (const source of agentCliRuntimeSpecSources) {
    lines.push(`  ${source.agentId}: Object.freeze(${renderJsonLiteral(source.runtimeSpec)} as const satisfies ProviderCliRuntimeDescriptor),`);
  }
  lines.push('});');
  lines.push('');
  lines.push('function readBundledFirstPartyAgentCliRuntimeSpec(agentId: string): ProviderCliRuntimeDescriptor {');
  lines.push('  const runtimeSpec = BUNDLED_FIRST_PARTY_AGENT_CLI_RUNTIME_SPECS_BY_ID[agentId];');
  lines.push('  if (!runtimeSpec) {');
  lines.push('    throw new Error(`Missing bundled first-party agent CLI runtime spec for agent \'${agentId}\'`);');
  lines.push('  }');
  lines.push('  return runtimeSpec;');
  lines.push('}');
  lines.push('');
  lines.push('function createBundledProviderCliCommandHandler(agentId: string): () => Promise<CommandHandler> {');
  lines.push('  return async () => {');
  lines.push('    const { runBackendSessionCliCommand } = await import(\'@/cli/runBackendSessionCliCommand\');');
  lines.push('    return async (context) => {');
  lines.push('      await runBackendSessionCliCommand({');
  lines.push('        context,');
  lines.push('        backendIdForSessionRuntime: agentId,');
  lines.push('        agentIdForAccountSettings: agentId as Parameters<typeof runBackendSessionCliCommand>[0][\'agentIdForAccountSettings\'],');
  lines.push('      });');
  lines.push('    };');
  lines.push('  };');
  lines.push('}');
  lines.push('');
  lines.push('export const BUNDLED_FIRST_PARTY_PROVIDER_CATALOG_ENTRY_HOOKS = Object.freeze({');
  for (const source of providerCatalogEntryHookSources) {
    lines.push(`  ${source.agentId}: createProviderRuntimeCatalogEntryHooks({`);
    lines.push(`    agentId: ${renderTsStringLiteral(source.agentId)},`);
    lines.push(`    packageName: ${renderTsStringLiteral(source.packageName)},`);
    if (source.systemTools.length > 0) {
      lines.push(`    systemTools: Object.freeze(${renderJsonLiteral(source.systemTools)}),`);
    }
    if (source.externalSessionHostAdapters) {
      lines.push('    contribution: {');
      lines.push(`      ...${source.importName},`);
      lines.push('      externalSessions: {');
      if (source.externalSessionHostAdapters.candidateHostAdapter) {
        lines.push(`        createCandidateHostAdapter: ${source.externalSessionHostAdapters.candidateHostAdapter.importAlias},`);
      }
      if (source.externalSessionHostAdapters.transcriptStoreAdapter) {
        lines.push(`        createTranscriptStoreAdapter: ${source.externalSessionHostAdapters.transcriptStoreAdapter.importAlias},`);
      }
      lines.push('      },');
      lines.push('    },');
    } else {
      lines.push(`    contribution: ${source.importName},`);
    }
    lines.push('  }),');
  }
  lines.push('} satisfies Readonly<Record<string, () => Partial<ResolvedCatalogEntry>>>);');
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
  lines.push('[');
  for (const source of builtInProviderContributionSources) {
    lines.push('  Object.freeze({');
    lines.push(`    id: ${JSON.stringify(source.id)},`);
    lines.push('    provenance: \'first_party\',');
    lines.push('    source: { kind: \'bundled\' },');
    lines.push(`    definition: Object.freeze(${renderJsonLiteral(source.definition)} as const satisfies ResolvedProviderContribution['definition']),`);
    lines.push(`    runtimeSpec: readBundledFirstPartyAgentCliRuntimeSpec(${JSON.stringify(source.id)}),`);
    lines.push('    catalogEntry: Object.freeze({');
    lines.push(`      id: ${JSON.stringify(source.id)},`);
    lines.push(`      cliSubcommand: ${JSON.stringify(source.cliSubcommand)},`);
    lines.push(`      getCliCommandHandler: createBundledProviderCliCommandHandler(${JSON.stringify(source.id)}),`);
    lines.push(`      vendorResumeSupport: ${JSON.stringify(source.vendorResumeSupport)},`);
    if (source.commandSurface?.rootHelpLabel !== undefined) {
      lines.push(`      rootHelpLabel: ${JSON.stringify(source.commandSurface.rootHelpLabel)},`);
    }
    if (source.commandSurface?.rootHelpDescription !== undefined) {
      lines.push(`      rootHelpDescription: ${JSON.stringify(source.commandSurface.rootHelpDescription)},`);
    }
    if (source.commandSurface?.rootHelpDetail !== undefined) {
      lines.push(`      rootHelpDetail: ${JSON.stringify(source.commandSurface.rootHelpDetail)},`);
    }
    if (source.commandSurface?.allowTmux !== undefined) {
      lines.push(`      allowTmux: ${JSON.stringify(source.commandSurface.allowTmux)},`);
    }
    lines.push('    } satisfies ResolvedCatalogEntry),');
    lines.push(`    ...buildBundledMetadataFields(${JSON.stringify(source.id)}),`);
    lines.push('  } satisfies ResolvedProviderContribution),');
  }
  lines.push(']');
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
  lines.push('const bundledBackendSurfaceHandlersById = new Map<string, NonNullable<ResolvedBackendContribution[\'surfaceHandlers\']>>([');
  for (const contribution of agentBackendSurfaceHandlerContributions) {
    const surfaceHandlers = readJsonArrayProperty(contribution.definition, 'surfaceHandlers');
    lines.push(`  [${JSON.stringify(contribution.id)}, Object.freeze(${renderJsonLiteral(surfaceHandlers)} as const)],`);
  }
  lines.push(']);');
  lines.push('');
  lines.push('export const BUNDLED_FIRST_PARTY_BACKEND_CONTRIBUTIONS: readonly ResolvedBackendContribution[] = Object.freeze(');
  lines.push('[');
  for (const source of builtInBackendContributionSources) {
    lines.push('  (() => {');
    lines.push(`    const surfaceHandlers = bundledBackendSurfaceHandlersById.get(${JSON.stringify(source.id)});`);
    lines.push('    return Object.freeze({');
    lines.push(`      id: ${JSON.stringify(source.id)},`);
    lines.push(`      providerId: ${JSON.stringify(source.providerId)},`);
    lines.push('      provenance: \'first_party\',');
    lines.push('      source: { kind: \'bundled\' },');
    lines.push(`      definition: Object.freeze(${renderJsonLiteral(source.definition)} as const satisfies ResolvedBackendContribution['definition']),`);
    lines.push(`      runtimeKind: ${JSON.stringify(source.runtimeKind)},`);
    lines.push('      ...(surfaceHandlers ? { surfaceHandlers } : {}),');
    lines.push(`      ...buildBundledMetadataFields(${JSON.stringify(source.providerId)}),`);
    lines.push('    } satisfies ResolvedBackendContribution);');
    lines.push('  })(),');
  }
  lines.push(']');
  lines.push(');');
  lines.push('');
  lines.push('export const BUNDLED_FIRST_PARTY_PLUGIN_BACKEND_CONTRIBUTIONS: readonly ResolvedBackendContribution[] = Object.freeze([');
  for (const contribution of reviewBackendContributions) {
    const capabilities = readJsonObjectProperty(contribution.definition, 'capabilities') ?? {};
    const surfaceHandlers = readJsonArrayProperty(contribution.definition, 'surfaceHandlers');
    const runtimeKind = readJsonObjectProperty(contribution.definition, 'engine')?.kind ?? null;
    const richDefinition = {
      kindVersion: 1,
      id: contribution.id,
      providerId: contribution.agentId,
      runtimeKind: typeof runtimeKind === 'string' && runtimeKind.trim().length > 0 ? runtimeKind : 'custom',
      ...(readOptionalJsonStringProperty(contribution.definition, 'title') ? { title: readOptionalJsonStringProperty(contribution.definition, 'title') } : {}),
      ...(readOptionalJsonStringProperty(contribution.definition, 'subtitle') ? { subtitle: readOptionalJsonStringProperty(contribution.definition, 'subtitle') } : {}),
      capabilities,
      surfaceHandlers,
    };
    lines.push('  Object.freeze({');
    lines.push(`    id: ${JSON.stringify(contribution.id)},`);
    lines.push(`    providerId: ${JSON.stringify(contribution.agentId)},`);
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
    lines.push(`    definition: Object.freeze(${renderJsonLiteral({
      kindVersion: 1,
      id: contribution.id,
      providerId: contribution.agentId,
    })} as const),`);
    lines.push('    richDefinition: {');
    lines.push('      provenance: \'external\',');
    lines.push(`      definition: Object.freeze(${renderJsonLiteral(richDefinition)} as const),`);
    lines.push('    },');
    lines.push(`    runtimeKind: ${renderJsonLiteral(runtimeKind)},`);
    lines.push(`    capabilities: Object.freeze(${renderJsonLiteral(capabilities)} as const),`);
    lines.push(`    surfaceHandlers: Object.freeze(${renderJsonLiteral(surfaceHandlers)} as const),`);
    lines.push('  } satisfies ResolvedBackendContribution),');
  }
  lines.push(']);');
  lines.push('');
  lines.push('export const BUNDLED_FIRST_PARTY_EXECUTION_RUN_PROFILE_CONTRIBUTIONS: readonly ResolvedExecutionRunProfileContribution[] = Object.freeze([');
  for (const contribution of executionRunProfileContributions) {
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
    lines.push(`    definition: Object.freeze(${renderJsonLiteral(contribution.definition)} as const satisfies ResolvedExecutionRunProfileContribution['definition']),`);
    lines.push('  } satisfies ResolvedExecutionRunProfileContribution),');
  }
  lines.push(']);');
  lines.push('');
  lines.push('export const BUNDLED_FIRST_PARTY_CATALOG_ENTRIES: readonly ResolvedCatalogEntry[] = Object.freeze(');
  lines.push('  BUNDLED_FIRST_PARTY_PROVIDER_CONTRIBUTIONS.map((provider) => provider.catalogEntry)');
  lines.push('    .filter((entry): entry is ResolvedCatalogEntry => Boolean(entry)),');
  lines.push(');');
  lines.push('');
  return lines.join('\n');
}

function toAgentConstPrefix(agentId: string): string {
  return agentId
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

function renderTsStringLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}'`;
}

function renderTsImportSpecifier(source: string): string {
  const normalized = source.replaceAll('\\', '/').trim();
  if (!normalized) {
    throw new Error('Invalid generated import source: expected non-empty string');
  }
  if (!normalized.startsWith('.') && !normalized.startsWith('/')) {
    return normalized;
  }
  return /\.(?:mjs|cjs|jsx?|tsx?)$/.test(normalized) ? normalized.replace(/\.(?:tsx?|jsx?)$/, '.js') : `${normalized}.js`;
}

function renderTsNullableStringLiteral(value: string | null): string {
  return value === null ? 'null' : renderTsStringLiteral(value);
}

function renderTsStringArrayLiteral(values: readonly string[]): string {
  return `[${values.map((value) => renderTsStringLiteral(value)).join(', ')}]`;
}

function renderProviderLogoSvgXmlExpression(svgIconKey: string | null): string {
  if (!svgIconKey) return 'null';
  if (/^[A-Za-z_$][\w$]*$/.test(svgIconKey)) {
    return `PROVIDER_LOGO_SVG_XML.${svgIconKey} ?? null`;
  }
  return `PROVIDER_LOGO_SVG_XML[${renderTsStringLiteral(svgIconKey)}] ?? null`;
}

function renderThemeColorExpression(token: string): string {
  return `theme.colors.${token}`;
}

function renderDescriptorGeneratedSvgPath(path: DescriptorGeneratedSvgIconPathSource): string {
  const attributes = [
    ...(path.fillToken === undefined ? [] : [`fill="\${${renderThemeColorExpression(path.fillToken)}}"`]),
    ...(path.fillOpacity === undefined ? [] : [`fill-opacity="${String(path.fillOpacity)}"`]),
    ...(path.fillRule === undefined ? [] : [`fill-rule="${path.fillRule}"`]),
    ...(path.clipRule === undefined ? [] : [`clip-rule="${path.clipRule}"`]),
    `d="${path.d}"`,
  ];
  return `<path ${attributes.join(' ')}/>`;
}

function renderDescriptorGeneratedSvgIconLines(source: DescriptorGeneratedSvgIconSource): readonly string[] {
  const lines: string[] = [];
  lines.push(`const ${source.constName}: AgentIconSvgXmlResolver = (theme): string => createGeneratedSvgIconXml(`);
  lines.push(`    ${renderTsStringLiteral(source.viewBox)},`);
  lines.push('    `');
  for (const path of source.paths) {
    lines.push(`        ${renderDescriptorGeneratedSvgPath(path)}`);
  }
  lines.push('    `,');
  lines.push(');');
  return lines;
}

function hasDescriptorFields(value: JsonObject | undefined): value is JsonObject {
  return value !== undefined && Object.keys(value).length > 0;
}

function readDescriptorString(value: JsonObject | undefined, key: string): string | null {
  const property = value?.[key];
  return typeof property === 'string' && property.trim().length > 0 ? property : null;
}

function readUiDescriptorSvgIconKey(descriptor: AgentUiDescriptor): string | null {
  const assetId = readJsonObjectProperty(descriptor.assets ?? {}, 'svgIcon')
    ? readDescriptorString(readJsonObjectProperty(descriptor.assets ?? {}, 'svgIcon') ?? undefined, 'assetId')
    : null;
  return assetId ?? descriptor.display.icon?.assetId ?? null;
}

function assertSafeSvgAttributeValue(value: string, path: string): void {
  if (
    value.trim().length === 0
    || /["`<>]/u.test(value)
    || value.includes('${')
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`Invalid agent UI descriptor at ${path}: expected safe SVG attribute text`);
  }
}

function readSvgRule(value: unknown, path: string): 'evenodd' | 'nonzero' | undefined {
  if (value === undefined) return undefined;
  if (value !== 'evenodd' && value !== 'nonzero') {
    throw new Error(`Invalid agent UI descriptor at ${path}: expected evenodd or nonzero`);
  }
  return value;
}

function readOptionalFillOpacity(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Invalid agent UI descriptor at ${path}: expected finite number between 0 and 1`);
  }
  return value;
}

function readSvgThemeToken(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u.test(value)) {
    throw new Error(`Invalid agent UI descriptor at ${path}: expected theme token path`);
  }
  return value;
}

function readDescriptorGeneratedSvgIcon(
  descriptor: AgentUiDescriptor,
  constPrefix: string,
): DescriptorGeneratedSvgIconSource | undefined {
  const svgIcon = readJsonObjectProperty(descriptor.assets ?? {}, 'svgIcon');
  if (!svgIcon) return undefined;

  const viewBox = readOptionalJsonStringProperty(svgIcon, 'viewBox') ?? undefined;
  const pathValues = readJsonArrayProperty(svgIcon, 'paths');
  if (viewBox === undefined && pathValues.length === 0) return undefined;
  if (viewBox === undefined || pathValues.length === 0) {
    throw new Error(
      `Invalid agent UI descriptor at assets.svgIcon for ${descriptor.agentId}: viewBox and paths must be provided together`,
    );
  }
  assertSafeSvgAttributeValue(viewBox, `${descriptor.agentId}.assets.svgIcon.viewBox`);

  return {
    constName: `${constPrefix}_SVG_ICON_XML`,
    viewBox,
    paths: pathValues.map((entry, index) => {
      const path = readRequiredRecord(entry, `${descriptor.agentId}.assets.svgIcon.paths[${String(index)}]`);
      const d = readRequiredString(path, 'd', `${descriptor.agentId}.assets.svgIcon.paths[${String(index)}]`);
      assertSafeSvgAttributeValue(d, `${descriptor.agentId}.assets.svgIcon.paths[${String(index)}].d`);
      return {
        d,
        ...(readSvgThemeToken(path.fillToken, `${descriptor.agentId}.assets.svgIcon.paths[${String(index)}].fillToken`) === undefined
          ? {}
          : {
            fillToken: readSvgThemeToken(
              path.fillToken,
              `${descriptor.agentId}.assets.svgIcon.paths[${String(index)}].fillToken`,
            ),
          }),
        ...(readOptionalFillOpacity(path.fillOpacity, `${descriptor.agentId}.assets.svgIcon.paths[${String(index)}].fillOpacity`) === undefined
          ? {}
          : {
            fillOpacity: readOptionalFillOpacity(
              path.fillOpacity,
              `${descriptor.agentId}.assets.svgIcon.paths[${String(index)}].fillOpacity`,
            ),
          }),
        ...(readSvgRule(path.fillRule, `${descriptor.agentId}.assets.svgIcon.paths[${String(index)}].fillRule`) === undefined
          ? {}
          : { fillRule: readSvgRule(path.fillRule, `${descriptor.agentId}.assets.svgIcon.paths[${String(index)}].fillRule`) }),
        ...(readSvgRule(path.clipRule, `${descriptor.agentId}.assets.svgIcon.paths[${String(index)}].clipRule`) === undefined
          ? {}
          : { clipRule: readSvgRule(path.clipRule, `${descriptor.agentId}.assets.svgIcon.paths[${String(index)}].clipRule`) }),
      };
    }),
  };
}

function readUiDescriptorCliGlyph(descriptor: AgentUiDescriptor): string {
  const glyph = AGENT_CLI_GLYPH_BY_TOKEN_ID[descriptor.display.picker.cliGlyphTokenId];
  if (!glyph) {
    throw new Error(
      `Unsupported CLI glyph token '${descriptor.display.picker.cliGlyphTokenId}' in UI descriptor for ${descriptor.agentId}`,
    );
  }
  return glyph;
}

function readUiConnectedServiceLabel(descriptor: AgentUiDescriptor): string {
  const labelKey = descriptor.display.connectedService.labelKey;
  return AGENT_CONNECTED_SERVICE_LABEL_BY_TOKEN_ID[labelKey] ?? labelKey;
}

function buildVisibleMessageDescriptor(descriptor: AgentUiDescriptor): JsonObject | undefined {
  const visibleMessages = readJsonObjectProperty(descriptor.session ?? {}, 'visibleMessages');
  if (hasDescriptorFields(visibleMessages ?? undefined)) return visibleMessages ?? undefined;

  const descriptorId = readDescriptorString(descriptor.session, 'visibleMessageFilterDescriptorId');
  if (!descriptorId) return undefined;
  return {
    kind: 'plugin.ui.visibleMessages.v1',
    descriptorId,
  };
}

function normalizePluginRuntimeProjectionSource(source: string): string {
  const normalized = source.replaceAll('\\', '/').trim();
  if (normalized === '.') {
    throw new Error(
      `Invalid plugin runtime projection source '${source}': first-party runtime contributions must use a narrow ./agent/contributions/runtime entrypoint`,
    );
  }
  if (!normalized.startsWith('./')) {
    throw new Error(`Invalid plugin runtime projection source '${source}': expected ./-relative path`);
  }
  const withoutPrefix = normalized.slice(2);
  if (
    withoutPrefix.length === 0
    || withoutPrefix.startsWith('/')
    || withoutPrefix.startsWith('../')
    || withoutPrefix.includes('/../')
    || withoutPrefix.endsWith('/..')
  ) {
    throw new Error(`Invalid plugin runtime projection source '${source}': path escapes src`);
  }
  return withoutPrefix.replace(/\.(?:tsx?|jsx?)$/, '');
}

function resolvePluginRuntimeProjectionSourceFile(repoRoot: string, pluginPackageId: string, source: string): string {
  const normalized = normalizePluginRuntimeProjectionSource(source);
  const basePath = normalized === '.'
    ? resolve(repoRoot, 'packages/plugins', pluginPackageId, 'src/index')
    : resolve(repoRoot, 'packages/plugins', pluginPackageId, 'src', normalized);
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
  ];
  const match = candidates.find((candidate) => existsSync(candidate));
  if (!match) {
    throw new Error(`Missing plugin runtime projection source for ${pluginPackageId}: ${source}`);
  }
  return match;
}

function renderPluginRuntimeProjectionImportPath(packageName: string, source: string): string {
  const normalized = normalizePluginRuntimeProjectionSource(source);
  return normalized === '.' ? packageName : `${packageName}/${normalized}`;
}

function renderAgentRuntimeContributionImportPath(packageName: string, source: string): string {
  const normalized = source.trim();
  if (normalized.startsWith('./')) {
    return renderPluginRuntimeProjectionImportPath(packageName, normalized);
  }
  return renderTsImportSpecifier(normalized);
}

function createExternalSessionHostAdapterImportSource(
  pluginPackage: BundledPluginPackage,
  descriptor: RuntimeProjectionExportDescriptor,
  importAlias: string,
): ExternalSessionHostAdapterImportSource {
  return {
    exportName: descriptor.exportName,
    importAlias,
    importPath: renderAgentRuntimeContributionImportPath(pluginPackage.packageName, descriptor.source),
  };
}

function createDescriptorAgentUiProjectionSource(descriptor: AgentUiDescriptor): DescriptorAgentUiProjectionSource {
  const constPrefix = toAgentConstPrefix(descriptor.agentId);
  const svgIcon = readDescriptorGeneratedSvgIcon(descriptor, constPrefix);
  return {
    agentId: descriptor.agentId,
    coreConst: `${constPrefix}_CORE`,
    uiConst: `${constPrefix}_UI`,
    descriptor,
    ...(svgIcon === undefined ? {} : { svgIcon }),
  };
}

function collectAgentUiBehaviorOverrideSources(pluginPackages: readonly BundledPluginPackage[]): readonly AgentUiBehaviorOverrideSource[] {
  return pluginPackages.flatMap((pluginPackage): AgentUiBehaviorOverrideSource[] => {
    const behavior = pluginPackage.agentUiDescriptor?.behavior;
    const components = pluginPackage.agentUiDescriptor?.components;
    const projection = {
      ...(hasDescriptorFields(behavior) ? behavior : {}),
      ...(hasDescriptorFields(components) ? { components } : {}),
    };
    if (!hasDescriptorFields(projection) || !pluginPackage.agentUiDescriptor?.agentId) return [];
    return [{
      agentId: pluginPackage.agentUiDescriptor.agentId,
      descriptor: projection,
    }];
  });
}

function collectAgentSessionProviderBehaviorSources(
  pluginPackages: readonly BundledPluginPackage[],
): readonly AgentSessionProviderBehaviorSource[] {
  return pluginPackages.flatMap((pluginPackage): AgentSessionProviderBehaviorSource[] => {
    const projection = pluginPackage.agentUiDescriptor?.session;
    if (!hasDescriptorFields(projection) || !pluginPackage.agentUiDescriptor?.agentId) return [];
    return [{
      agentId: pluginPackage.agentUiDescriptor.agentId,
      descriptor: projection,
    }];
  });
}

function collectProviderMessageMetaOverrideSources(
  pluginPackages: readonly BundledPluginPackage[],
): readonly ProviderMessageMetaOverrideSource[] {
  return pluginPackages.flatMap((pluginPackage): ProviderMessageMetaOverrideSource[] => {
    const projection = pluginPackage.agentUiDescriptor?.message;
    if (!hasDescriptorFields(projection) || !pluginPackage.agentUiDescriptor?.agentId) return [];
    return [{
      agentId: pluginPackage.agentUiDescriptor.agentId,
      descriptor: projection,
    }];
  });
}

function collectProviderSettingsSources(pluginPackages: readonly BundledPluginPackage[]): readonly ProviderSettingsSource[] {
  return pluginPackages.flatMap((pluginPackage): ProviderSettingsSource[] => {
    const projection = pluginPackage.agentUiDescriptor?.settings;
    if (!hasDescriptorFields(projection) || !pluginPackage.agentUiDescriptor?.agentId) return [];
    return [{
      agentId: pluginPackage.agentUiDescriptor.agentId,
      descriptor: projection,
    }];
  });
}

function collectVisibleMessageResolverSources(
  pluginPackages: readonly BundledPluginPackage[],
): readonly SessionSubagentVisibleMessageResolverSource[] {
  return pluginPackages.flatMap((pluginPackage): SessionSubagentVisibleMessageResolverSource[] => {
    const projection = pluginPackage.agentUiDescriptor
      ? buildVisibleMessageDescriptor(pluginPackage.agentUiDescriptor)
      : undefined;
    if (!projection || !pluginPackage.agentUiDescriptor?.agentId) return [];
    return [{
      agentId: pluginPackage.agentUiDescriptor.agentId,
      descriptor: projection,
    }];
  });
}

function collectProviderCatalogEntryHookSources(
  pluginPackages: readonly BundledPluginPackage[],
): readonly ProviderCatalogEntryHookSource[] {
  return pluginPackages.flatMap((pluginPackage): ProviderCatalogEntryHookSource[] => {
    const projection = pluginPackage.agentRuntimeContributions?.providerCatalogEntry;
    if (!projection || !pluginPackage.agentId) return [];
    const externalSessionHostAdapters = pluginPackage.agentRuntimeContributions?.externalSessionHostAdapters;
    const constPrefix = toAgentConstPrefix(pluginPackage.agentId);
    return [{
      agentId: pluginPackage.agentId,
      importName: projection.importName,
      importPath: renderPluginRuntimeProjectionImportPath(pluginPackage.packageName, projection.source),
      packageName: pluginPackage.packageName,
      systemTools: readManifestContributionArray(pluginPackage.manifest, 'systemTools'),
      ...(externalSessionHostAdapters
        ? {
            externalSessionHostAdapters: {
              ...(externalSessionHostAdapters.candidateHostAdapter
                ? {
                    candidateHostAdapter: createExternalSessionHostAdapterImportSource(
                      pluginPackage,
                      externalSessionHostAdapters.candidateHostAdapter,
                      `${constPrefix}_EXTERNAL_SESSION_CREATE_CANDIDATE_HOST_ADAPTER`,
                    ),
                  }
                : {}),
              ...(externalSessionHostAdapters.transcriptStoreAdapter
                ? {
                    transcriptStoreAdapter: createExternalSessionHostAdapterImportSource(
                      pluginPackage,
                      externalSessionHostAdapters.transcriptStoreAdapter,
                      `${constPrefix}_EXTERNAL_SESSION_CREATE_TRANSCRIPT_STORE_ADAPTER`,
                    ),
                  }
                : {}),
            },
          }
        : {}),
    }];
  });
}

function renderDescriptorGeneratedUiProjectionLines(source: DescriptorAgentUiProjectionSource): readonly string[] {
  const { descriptor } = source;
  const agentId = renderTsStringLiteral(descriptor.agentId);
  const svgIconXmlExpression = source.svgIcon?.constName ?? renderProviderLogoSvgXmlExpression(readUiDescriptorSvgIconKey(descriptor));
  const lines: string[] = [];
  if (source.svgIcon) {
    lines.push(...renderDescriptorGeneratedSvgIconLines(source.svgIcon));
    lines.push('');
  }
  lines.push(`const ${source.coreConst}: AgentCoreConfig = {`);
  lines.push(`    id: ${agentId},`);
  lines.push(`    displayNameKey: ${renderTsStringLiteral(descriptor.display.nameKey)},`);
  lines.push(`    subtitleKey: ${renderTsStringLiteral(descriptor.display.subtitleKey)},`);
  lines.push(`    permissionModeI18nPrefix: ${renderTsStringLiteral(descriptor.display.permissionModeI18nPrefix)},`);
  lines.push(`    availability: { experimental: ${String(descriptor.display.availability.experimental)} },`);
  lines.push(`    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: ${agentId} }),`);
  lines.push(
    `    uiConnectedService: { serviceId: ${renderTsNullableStringLiteral(descriptor.display.connectedService.serviceId)}, label: ${renderTsStringLiteral(readUiConnectedServiceLabel(descriptor))}, connectRoute: ${renderTsNullableStringLiteral(descriptor.display.connectedService.connectRoute)} },`,
  );
  lines.push(`    flavorAliases: ${renderTsStringArrayLiteral(descriptor.display.flavorAliases)},`);
  lines.push(`    cli: buildCatalogProviderCliUiConfig(${agentId}),`);
  lines.push('    permissions: {');
  lines.push(`        modeGroup: ${renderTsStringLiteral(descriptor.display.permissions.modeGroup)},`);
  lines.push(`        promptProtocol: ${renderTsStringLiteral(descriptor.display.permissions.promptProtocol)},`);
  lines.push('    },');
  lines.push('    sessionModes: {');
  lines.push(`        kind: getAgentSessionModesKind(${agentId}),`);
  const staticOptions = descriptor.display.sessionModes?.staticOptions;
  if (staticOptions && staticOptions.length > 0) {
    lines.push('        staticOptions: [');
    for (const option of staticOptions) {
      const fields = [
        `id: ${renderTsStringLiteral(option.id)}`,
        `nameKey: ${renderTsStringLiteral(option.nameKey)}`,
        ...(option.descriptionKey === undefined
          ? []
          : [`descriptionKey: ${renderTsStringLiteral(option.descriptionKey)}`]),
      ];
      lines.push(`            { ${fields.join(', ')} },`);
    }
    lines.push('        ],');
  }
  lines.push('    },');
  if (descriptor.display.runtimeInput) {
    lines.push('    runtimeInput: {');
    lines.push(`        inFlightSteerSupported: ${String(descriptor.display.runtimeInput.inFlightSteerSupported)},`);
    lines.push('    },');
  }
  lines.push(`    model: getAgentModelConfig(${agentId}),`);
  lines.push('    resume: buildAgentResumeUiConfig({');
  lines.push(`        agentId: ${agentId},`);
  lines.push(`        uiVendorResumeIdLabelKey: ${renderTsNullableStringLiteral(descriptor.display.resume.uiVendorResumeIdLabelKey)},`);
  lines.push(`        uiVendorResumeIdCopiedKey: ${renderTsNullableStringLiteral(descriptor.display.resume.uiVendorResumeIdCopiedKey)},`);
  lines.push('    }),');
  if (descriptor.display.localControl === true) {
    lines.push(`    localControl: buildAgentLocalControlUiConfig({ agentId: ${agentId} }),`);
  }
  lines.push('    toolRendering: {');
  lines.push(`        hideUnknownToolsByDefault: ${String(descriptor.display.toolRendering.hideUnknownToolsByDefault)},`);
  lines.push('    },');
  lines.push(`    tools: buildAgentToolsUiConfig({ agentId: ${agentId} }),`);
  lines.push(`    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: ${agentId} }),`);
  lines.push('    ui: {');
  lines.push(`        agentPickerIconName: ${renderTsStringLiteral(descriptor.display.picker.iconName)},`);
  lines.push(`        cliGlyphScale: ${String(descriptor.display.picker.cliGlyphScale)},`);
  lines.push(`        profileCompatibilityGlyphScale: ${String(descriptor.display.picker.profileCompatibilityGlyphScale)},`);
  lines.push('    },');
  lines.push('};');
  lines.push('');
  lines.push(`const ${source.uiConst}: AgentUiConfig = {`);
  lines.push(`    id: ${agentId},`);
  lines.push('    icon: null,');
  lines.push(`    svgIconXml: ${svgIconXmlExpression},`);
  if (typeof descriptor.display.picker.iconScale === 'number') {
    lines.push(`    pickerIconScale: ${String(descriptor.display.picker.iconScale)},`);
  }
  lines.push('    tintColor: null,');
  lines.push('    avatarOverlay: {');
  lines.push(`        circleScale: ${String(descriptor.display.avatarOverlay.circleScale)},`);
  lines.push(`        iconScale: ({ size }: { size: number }) => Math.round(size * ${String(descriptor.display.avatarOverlay.iconScaleRatio)}),`);
  lines.push('    },');
  lines.push(`    cliGlyph: ${renderTsStringLiteral(readUiDescriptorCliGlyph(descriptor))},`);
  lines.push('};');
  return lines;
}

function renderQwenGeneratedUiProjectionLines(): readonly string[] {
  return [
    'const QWEN_CORE: AgentCoreConfig = {',
    '    id: \'qwen\',',
    '    displayNameKey: \'agentInput.agent.qwen\',',
    '    subtitleKey: \'profiles.aiBackend.qwenSubtitleExperimental\',',
    '    permissionModeI18nPrefix: \'agentInput.codexPermissionMode\',',
    '    availability: { experimental: true },',
    '    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: \'qwen\' }),',
    '    uiConnectedService: { serviceId: null, label: \'Qwen\', connectRoute: null },',
    '    flavorAliases: [\'qwen\', \'qwen-code\'],',
    '    cli: buildCatalogProviderCliUiConfig(\'qwen\'),',
    '    permissions: {',
    '        modeGroup: \'codexLike\',',
    '        promptProtocol: \'codexDecision\',',
    '    },',
    '    sessionModes: {',
    '        kind: getAgentSessionModesKind(\'qwen\'),',
    '    },',
    '    model: getAgentModelConfig(\'qwen\'),',
    '    resume: buildAgentResumeUiConfig({',
    '        agentId: \'qwen\',',
    '        uiVendorResumeIdLabelKey: \'sessionInfo.qwenSessionId\',',
    '        uiVendorResumeIdCopiedKey: \'sessionInfo.qwenSessionIdCopied\',',
    '    }),',
    '    toolRendering: {',
    '        hideUnknownToolsByDefault: true,',
    '    },',
    '    tools: buildAgentToolsUiConfig({ agentId: \'qwen\' }),',
    '    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: \'qwen\' }),',
    '    ui: {',
    '        agentPickerIconName: \'code-slash-outline\',',
    '        cliGlyphScale: 1.0,',
    '        profileCompatibilityGlyphScale: 1.0,',
    '    },',
    '};',
    '',
    'const QWEN_UI: AgentUiConfig = {',
    '    id: \'qwen\',',
    '    icon: null,',
    '    svgIconXml: PROVIDER_LOGO_SVG_XML.qwen ?? null,',
    '    pickerIconScale: 0.9,',
    '    tintColor: null,',
    '    avatarOverlay: {',
    '        circleScale: 0.35,',
    '        iconScale: ({ size }: { size: number }) => Math.round(size * 0.22),',
    '    },',
    '    cliGlyph: \'Q\',',
    '};',
  ];
}

function renderKiroGeneratedUiProjectionLines(): readonly string[] {
  return [
    'const KIRO_CORE: AgentCoreConfig = {',
    '    id: \'kiro\',',
    '    displayNameKey: \'agentInput.agent.kiro\',',
    '    subtitleKey: \'profiles.aiBackend.kiroSubtitleExperimental\',',
    '    permissionModeI18nPrefix: \'agentInput.codexPermissionMode\',',
    '    availability: { experimental: true },',
    '    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: \'kiro\' }),',
    '    uiConnectedService: { serviceId: null, label: \'Kiro\', connectRoute: null },',
    '    flavorAliases: [\'kiro\', \'kiro-cli\'],',
    '    cli: buildCatalogProviderCliUiConfig(\'kiro\'),',
    '    permissions: {',
    '        modeGroup: \'codexLike\',',
    '        promptProtocol: \'codexDecision\',',
    '    },',
    '    sessionModes: {',
    '        kind: getAgentSessionModesKind(\'kiro\'),',
    '    },',
    '    model: getAgentModelConfig(\'kiro\'),',
    '    resume: buildAgentResumeUiConfig({',
    '        agentId: \'kiro\',',
    '        uiVendorResumeIdLabelKey: \'sessionInfo.kiroSessionId\',',
    '        uiVendorResumeIdCopiedKey: \'sessionInfo.kiroSessionIdCopied\',',
    '    }),',
    '    localControl: buildAgentLocalControlUiConfig({ agentId: \'kiro\' }),',
    '    toolRendering: {',
    '        hideUnknownToolsByDefault: false,',
    '    },',
    '    tools: buildAgentToolsUiConfig({ agentId: \'kiro\' }),',
    '    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: \'kiro\' }),',
    '    ui: {',
    '        agentPickerIconName: \'flash-outline\',',
    '        cliGlyphScale: 1.0,',
    '        profileCompatibilityGlyphScale: 1.0,',
    '    },',
    '};',
    '',
    'const KIRO_UI: AgentUiConfig = {',
    '    id: \'kiro\',',
    '    icon: null,',
    '    svgIconXml: PROVIDER_LOGO_SVG_XML.kiro ?? null,',
    '    pickerIconScale: 1.25,',
    '    tintColor: null,',
    '    avatarOverlay: {',
    '        circleScale: 0.35,',
    '        iconScale: ({ size }: { size: number }) => Math.round(size * 0.22),',
    '    },',
    '    cliGlyph: \'KR\',',
    '};',
  ];
}

function renderUiBundledPluginEntriesTs(params: Readonly<{
  packageNames: readonly string[];
  pluginPackages: readonly BundledPluginPackage[];
}>): string {
  const generatedSourcesByAgentId = new Map(
    GENERATED_AGENT_UI_PROJECTION_SOURCES.map((source) => [source.agentId, source] as const),
  );
  const descriptorSourcesByAgentId = new Map(
    params.pluginPackages
      .flatMap((entry) => (entry.agentUiDescriptor ? [createDescriptorAgentUiProjectionSource(entry.agentUiDescriptor)] : []))
      .map((source) => [source.agentId, source] as const),
  );
  const bundledAgentIds = new Set(
    params.pluginPackages.flatMap((entry) => (entry.agentId ? [entry.agentId] : [])),
  );
  const selectedProjectionSources = AGENT_UI_PROJECTION_ORDER.flatMap((agentId) => {
    const descriptorSource = descriptorSourcesByAgentId.get(agentId);
    const generatedSource = generatedSourcesByAgentId.get(agentId);
    if (!descriptorSource && !generatedSource) return [];
    const projectionLines = descriptorSource
      ? renderDescriptorGeneratedUiProjectionLines(descriptorSource)
      : generatedSource?.renderLines() ?? [];
    return [{
      agentId,
      coreConst: descriptorSource?.coreConst ?? generatedSource?.coreConst,
      uiConst: descriptorSource?.uiConst ?? generatedSource?.uiConst,
      projectionLines,
    }];
  });
  const selectedProjectionSourcesByAgentId = new Map(
    selectedProjectionSources.map((source) => [source.agentId, source] as const),
  );
  const usesGeneratedSvgIcons = selectedProjectionSources.some((source) =>
    source.projectionLines.some((line) =>
      line.includes('AgentIconSvgXmlResolver') || line.includes('createGeneratedSvgIconXml('),
    ),
  );

  const lines: string[] = [];
  lines.push('/* eslint-disable @typescript-eslint/naming-convention */');
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (PS-04)');
  lines.push(' *');
  lines.push(' * This file is the UI-side generated bundled entry map for first-party bundled plugins.');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`');
  lines.push(' *');
  lines.push(' * UI facts here are descriptor-derived and no-execute; this file must not import plugin UI runtime exports.');
  lines.push(' */');
  lines.push('');
  lines.push('import type { AgentCoreConfig, CanonicalAgentId } from \'./registryCore\';');
  lines.push(usesGeneratedSvgIcons
    ? 'import type { AgentIconSvgXmlResolver, AgentUiConfig } from \'./registryUi\';'
    : 'import type { AgentUiConfig } from \'./registryUi\';');
  lines.push('import { PROVIDER_LOGO_SVG_XML } from \'./providerLogoSvgXml\';');
  lines.push('');
  lines.push('import { buildCatalogProviderCliUiConfig } from \'@/agents/providers/shared/buildCatalogProviderCliUiConfig\';');
  lines.push('import { buildAgentConnectedServicesUiConfig } from \'@/agents/registry/buildAgentConnectedServicesUiConfig\';');
  lines.push('import { buildAgentLocalControlUiConfig } from \'@/agents/registry/buildAgentLocalControlUiConfig\';');
  lines.push('import { buildAgentResumeUiConfig } from \'@/agents/registry/buildAgentResumeUiConfig\';');
  lines.push('import { buildAgentSessionStorageUiConfig } from \'@/agents/registry/buildAgentSessionStorageUiConfig\';');
  lines.push('import { buildAgentToolsUiConfig } from \'@/agents/registry/buildAgentToolsUiConfig\';');
  lines.push('import { getAgentModelConfig, getAgentSessionModesKind } from \'@happier-dev/agents\';');
  lines.push('');
  if (usesGeneratedSvgIcons) {
    lines.push('function normalizeGeneratedSvgXml(xml: string): string {');
    lines.push('    return xml.replace(/\\s{2,}/g, \' \').trim();');
    lines.push('}');
    lines.push('');
    lines.push('function createGeneratedSvgIconXml(viewBox: string, body: string): string {');
    lines.push('    return normalizeGeneratedSvgXml(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`);');
    lines.push('}');
    lines.push('');
  }
  for (const source of selectedProjectionSources) {
    lines.push(...source.projectionLines);
    lines.push('');
  }
  lines.push('export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES: readonly string[] = Object.freeze([');
  for (const packageName of params.packageNames) {
    lines.push(`  ${JSON.stringify(packageName)},`);
  }
  lines.push(']);');
  lines.push('');
  lines.push('export const BUNDLED_CANONICAL_AGENTS_CORE: Readonly<Record<CanonicalAgentId, AgentCoreConfig>> = Object.freeze({');
  for (const agentId of AGENT_UI_PROJECTION_ORDER) {
    const valueName = selectedProjectionSourcesByAgentId.get(agentId)?.coreConst;
    if (!valueName) {
      if (!bundledAgentIds.has(agentId)) continue;
      throw new Error(`Missing UI core projection source for ${agentId}`);
    }
    lines.push(`    ${agentId}: ${valueName},`);
  }
  lines.push('} satisfies Readonly<Record<CanonicalAgentId, AgentCoreConfig>>);');
  lines.push('');
  lines.push('export const BUNDLED_CANONICAL_AGENTS_UI: Readonly<Record<CanonicalAgentId, AgentUiConfig>> = Object.freeze({');
  for (const agentId of AGENT_UI_PROJECTION_ORDER) {
    const valueName = selectedProjectionSourcesByAgentId.get(agentId)?.uiConst;
    if (!valueName) {
      if (!bundledAgentIds.has(agentId)) continue;
      throw new Error(`Missing UI projection source for ${agentId}`);
    }
    lines.push(`    ${agentId}: ${valueName},`);
  }
  lines.push('} satisfies Readonly<Record<CanonicalAgentId, AgentUiConfig>>);');
  lines.push('');
  return lines.join('\n');
}

function renderBundledUiBehaviorOverridesTs(sources: readonly AgentUiBehaviorOverrideSource[]): string {
  const lines: string[] = [];
  lines.push('/* eslint-disable @typescript-eslint/naming-convention */');
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (PS-04)');
  lines.push(' *');
  lines.push(' * This file is the UI-side generated bundled entry map for first-party bundled');
  lines.push(' * agent UI behavior overrides.');
  lines.push(' *');
  lines.push(' * It is split out from `generatedBundledPluginEntries.ts` to avoid import cycles');
  lines.push(' * between agent UI behavior graphs and the core registry maps.');
  lines.push(' *');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`');
  lines.push(' */');
  lines.push('');
  lines.push('import type { CanonicalAgentId } from \'./registryCore\';');
  lines.push('import type { AgentUiBehavior } from \'./registryUiBehavior\';');
  lines.push('');
  lines.push('export type BundledAgentUiBehaviorDescriptor = Readonly<{');
  lines.push('    agentId: CanonicalAgentId;');
  lines.push('    descriptor: Readonly<Record<string, unknown>>;');
  lines.push('}>;');
  lines.push('');
  lines.push('export const BUNDLED_CANONICAL_AGENT_UI_BEHAVIOR_DESCRIPTORS: Readonly<');
  lines.push('    Partial<Record<CanonicalAgentId, BundledAgentUiBehaviorDescriptor>>');
  lines.push('> = Object.freeze({');
  for (const source of sources) {
    lines.push(`    ${source.agentId}: Object.freeze({`);
    lines.push(`        agentId: ${renderTsStringLiteral(source.agentId)} as CanonicalAgentId,`);
    lines.push(`        descriptor: Object.freeze(${renderJsonLiteral(source.descriptor)} as const),`);
    lines.push('    }),');
  }
  lines.push('});');
  lines.push('');
  lines.push('export const BUNDLED_CANONICAL_AGENT_UI_BEHAVIOR_OVERRIDES: Readonly<');
  lines.push('    Partial<Record<CanonicalAgentId, AgentUiBehavior>>');
  lines.push('> = Object.freeze({});');
  lines.push('');
  return lines.join('\n');
}

function renderBundledSessionProviderBehaviorsTs(sources: readonly AgentSessionProviderBehaviorSource[]): string {
  const lines: string[] = [];
  lines.push('/* eslint-disable @typescript-eslint/naming-convention */');
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (PS-04)');
  lines.push(' *');
  lines.push(' * This file is the UI-side generated bundled entry map for first-party bundled');
  lines.push(' * agent session provider behaviors.');
  lines.push(' *');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`');
  lines.push(' */');
  lines.push('');
  lines.push('import type { CanonicalAgentId } from \'./registryCore\';');
  lines.push('import type { SessionProviderBehavior } from \'@/sync/domains/session/providers/sessionProviderBehaviorTypes\';');
  lines.push('');
  lines.push('export type BundledSessionProviderBehaviorDescriptor = Readonly<{');
  lines.push('    agentId: CanonicalAgentId;');
  lines.push('    descriptor: Readonly<Record<string, unknown>>;');
  lines.push('}>;');
  lines.push('');
  lines.push('export const BUNDLED_CANONICAL_AGENT_SESSION_PROVIDER_BEHAVIOR_DESCRIPTORS: Readonly<');
  lines.push('    Partial<Record<CanonicalAgentId, BundledSessionProviderBehaviorDescriptor>>');
  lines.push('> = Object.freeze({');
  for (const source of sources) {
    lines.push(`    ${source.agentId}: Object.freeze({`);
    lines.push(`        agentId: ${renderTsStringLiteral(source.agentId)} as CanonicalAgentId,`);
    lines.push(`        descriptor: Object.freeze(${renderJsonLiteral(source.descriptor)} as const),`);
    lines.push('    }),');
  }
  lines.push('});');
  lines.push('');
  lines.push('export const BUNDLED_CANONICAL_AGENT_SESSION_PROVIDER_BEHAVIORS: Readonly<');
  lines.push('    Partial<Record<CanonicalAgentId, SessionProviderBehavior>>');
  lines.push('> = Object.freeze({});');
  lines.push('');
  return lines.join('\n');
}

function renderBundledMessageMetaOverridesTs(sources: readonly ProviderMessageMetaOverrideSource[]): string {
  const lines: string[] = [];
  lines.push('/* eslint-disable @typescript-eslint/naming-convention */');
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (PS-04)');
  lines.push(' *');
  lines.push(' * This file is the UI-side generated bundled entry map for first-party bundled');
  lines.push(' * provider message metadata override builders.');
  lines.push(' *');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`');
  lines.push(' */');
  lines.push('');
  lines.push('import type { AgentId } from \'@/agents/catalog/catalog\';');
  lines.push('');
  lines.push('export type ProviderMessageMetaOverrideDescriptor = Readonly<{');
  lines.push('    agentId: AgentId;');
  lines.push('    descriptor: Readonly<Record<string, unknown>>;');
  lines.push('}>;');
  lines.push('');
  lines.push('export type ProviderMessageMetaOverrideBuilder = (params: Readonly<{');
  lines.push('    session: unknown;');
  lines.push('    metaOverrides?: Record<string, unknown>;');
  lines.push('}>) => Record<string, unknown> | undefined;');
  lines.push('');
  lines.push('export const BUNDLED_PROVIDER_MESSAGE_META_OVERRIDE_DESCRIPTORS: Readonly<');
  lines.push('    Partial<Record<AgentId, ProviderMessageMetaOverrideDescriptor>>');
  lines.push('> = Object.freeze({');
  for (const source of sources) {
    lines.push(`    ${source.agentId}: Object.freeze({`);
    lines.push(`        agentId: ${renderTsStringLiteral(source.agentId)} as AgentId,`);
    lines.push(`        descriptor: Object.freeze(${renderJsonLiteral(source.descriptor)} as const),`);
    lines.push('    }),');
  }
  lines.push('});');
  lines.push('');
  lines.push('export const BUNDLED_PROVIDER_MESSAGE_META_OVERRIDE_BUILDERS: Readonly<');
  lines.push('    Partial<Record<AgentId, ProviderMessageMetaOverrideBuilder>>');
  lines.push('> = Object.freeze({});');
  lines.push('');
  return lines.join('\n');
}

function renderBundledProviderSettingsTs(sources: readonly ProviderSettingsSource[]): string {
  const lines: string[] = [];
  lines.push('/* eslint-disable @typescript-eslint/naming-convention */');
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (PS-04)');
  lines.push(' *');
  lines.push(' * This file is the UI-side generated bundled entry list for first-party bundled');
  lines.push(' * provider settings plugins.');
  lines.push(' *');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`');
  lines.push(' */');
  lines.push('');
  lines.push('import type { ProviderSettingsPlugin } from \'@/agents/providers/shared/providerSettingsPlugin\';');
  lines.push('');
  lines.push('export type BundledProviderSettingsDescriptor = Readonly<{');
  lines.push('    agentId: string;');
  lines.push('    descriptor: Readonly<Record<string, unknown>>;');
  lines.push('}>;');
  lines.push('');
  lines.push('export const BUNDLED_PROVIDER_SETTINGS_DESCRIPTORS: readonly BundledProviderSettingsDescriptor[] = Object.freeze([');
  for (const source of sources) {
    lines.push('    Object.freeze({');
    lines.push(`        agentId: ${renderTsStringLiteral(source.agentId)},`);
    lines.push(`        descriptor: Object.freeze(${renderJsonLiteral(source.descriptor)} as const),`);
    lines.push('    }),');
  }
  lines.push(']);');
  lines.push('');
  lines.push('export const BUNDLED_PROVIDER_SETTINGS_PLUGINS: readonly ProviderSettingsPlugin[] = Object.freeze([');
  lines.push(']);');
  lines.push('');
  return lines.join('\n');
}

function renderBundledVisibleMessageResolversTs(
  sources: readonly SessionSubagentVisibleMessageResolverSource[],
): string {
  const lines: string[] = [];
  lines.push('/* eslint-disable @typescript-eslint/naming-convention */');
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (PS-04)');
  lines.push(' *');
  lines.push(' * This file is the UI-side generated bundled entry list for first-party bundled');
  lines.push(' * session subagent visible-message resolvers.');
  lines.push(' *');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`');
  lines.push(' */');
  lines.push('');
  lines.push('import type { SessionSubagentVisibleMessagesResolver } from \'@/sync/domains/session/subagents/visibleMessages/types\';');
  lines.push('');
  lines.push('export type BundledSessionSubagentVisibleMessageDescriptor = Readonly<{');
  lines.push('    agentId: string;');
  lines.push('    descriptor: Readonly<Record<string, unknown>>;');
  lines.push('}>;');
  lines.push('');
  lines.push('export type BundledSessionSubagentVisibleMessageRegistryEntry = Readonly<{');
  lines.push('    agentId: string;');
  lines.push('    resolveVisibleMessages: SessionSubagentVisibleMessagesResolver;');
  lines.push('}>;');
  lines.push('');
  lines.push('export const BUNDLED_SESSION_SUBAGENT_VISIBLE_MESSAGE_DESCRIPTORS: readonly BundledSessionSubagentVisibleMessageDescriptor[] = Object.freeze([');
  for (const source of sources) {
    lines.push('    Object.freeze({');
    lines.push(`        agentId: ${renderTsStringLiteral(source.agentId)},`);
    lines.push(`        descriptor: Object.freeze(${renderJsonLiteral(source.descriptor)} as const),`);
    lines.push('    }),');
  }
  lines.push(']);');
  lines.push('');
  lines.push('export const BUNDLED_SESSION_SUBAGENT_VISIBLE_MESSAGE_REGISTRY: readonly BundledSessionSubagentVisibleMessageRegistryEntry[] = Object.freeze([');
  lines.push(']);');
  lines.push('');
  return lines.join('\n');
}

function collectPromptAssetContributionSources(
  pluginPackages: readonly BundledPluginPackage[],
): readonly PromptAssetContributionSource[] {
  return pluginPackages
    .flatMap((pluginPackage) => (
      pluginPackage.promptAssetContributions ? [pluginPackage.promptAssetContributions] : []
    ))
    .sort((a, b) => a.pluginPackageId.localeCompare(b.pluginPackageId));
}

function renderCliPromptAssetPluginDescriptorsTs(
  sources: readonly PromptAssetContributionSource[],
): string {
  const lines: string[] = [];
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (A.16y.4-agent-runtime-codegen-and-prompt-assets-cleanup)');
  lines.push(' *');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`');
  lines.push(' */');
  lines.push('');
  lines.push('import type { PluginPromptAssetContributionV1 } from \'@happier-dev/protocol\';');
  for (const source of sources) {
    lines.push(
      `import { ${PLUGIN_PROMPT_ASSET_EXPORT_NAME} as ${source.importName} } from ${renderTsStringLiteral(source.importPath)};`,
    );
  }
  lines.push('');
  lines.push('export const BUNDLED_FIRST_PARTY_PLUGIN_PROMPT_ASSET_DESCRIPTORS: readonly PluginPromptAssetContributionV1[] = Object.freeze([');
  for (const source of sources) {
    lines.push(`  ...${source.importName},`);
  }
  lines.push(']);');
  lines.push('');
  return lines.join('\n');
}

function assertGeneratedOutputMatches(filePath: string, expected: string): void {
  if (!existsSync(filePath)) {
    throw new Error(`missing generated output: ${filePath}`);
  }
  if (readFileSync(filePath, 'utf8') !== expected) {
    throw new Error(`generated output differs: ${filePath}`);
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseCliArgs(argv);
  const pluginPackages = await readBundledPluginPackages(options.rootDir);
  const packageNames = pluginPackages.map((entry) => entry.packageName);
  const bundledAgentDefinitionIds = pluginPackages
    .map((entry) => entry.agentId)
    .filter((agentId): agentId is string => typeof agentId === 'string');
  const seenAgentIds = new Set<string>();
  for (const agentId of bundledAgentDefinitionIds) {
    if (seenAgentIds.has(agentId)) {
      throw new Error(`Duplicate bundled agent provider id '${agentId}'`);
    }
    seenAgentIds.add(agentId);
  }
  const agentProviderIds = collectGeneratedAgentProviderIds(bundledAgentDefinitionIds);
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
  const sessionProviderBehaviorsOutPath = resolve(
    options.rootDir,
    'apps/ui/sources/agents/registry/generatedBundledPluginEntries.sessionProviderBehaviors.ts',
  );
  const messageMetaOverridesOutPath = resolve(
    options.rootDir,
    'apps/ui/sources/agents/registry/generatedBundledPluginEntries.messageMetaOverrides.ts',
  );
  const providerSettingsOutPath = resolve(
    options.rootDir,
    'apps/ui/sources/agents/registry/generatedBundledPluginEntries.providerSettings.ts',
  );
  const visibleMessageResolversOutPath = resolve(
    options.rootDir,
    'apps/ui/sources/agents/registry/generatedBundledPluginEntries.visibleMessageResolvers.ts',
  );
  const agentsOutPath = resolve(options.rootDir, 'packages/agents/src/generated/bundledAgentDefinitions.ts');
  const agentProviderIdsOutPath = resolve(options.rootDir, 'packages/agents/src/generated/agentProviderIds.ts');
  const sessionControlAdaptersOutPath = resolve(options.rootDir, 'packages/agents/src/generated/sessionControlAdapters.ts');
  const runtimeDescriptorReadersOutPath = resolve(options.rootDir, 'packages/agents/src/generated/runtimeDescriptorReaders.ts');
  const protocolAgentProviderIdsV1OutPath = resolve(options.rootDir, 'packages/protocol/src/providers/agentProviderIdsV1.ts');
  const protocolRuntimeDescriptorContributionsOutPath = resolve(
    options.rootDir,
    'packages/protocol/src/providers/runtimeDescriptorContributionsV1.ts',
  );
  const protocolRuntimeDescriptorContributions = collectProtocolRuntimeDescriptorContributions(
    pluginPackages,
    options.rootDir,
  );
  const protocolRuntimeDescriptorModuleOutputs = protocolRuntimeDescriptorContributions.map((contribution) => ({
    outPath: resolve(
      options.rootDir,
      'packages/protocol/src/providers/generated/runtime/descriptors',
      contribution.moduleFileName,
    ),
    out: renderGeneratedProtocolRuntimeDescriptorModuleTs(contribution),
  }));
  const protocolBuiltInBackendProfilesOutPath = resolve(
    options.rootDir,
    'packages/protocol/src/providers/generated/profiles/builtInBackendProfiles.ts',
  );
  const protocolMemoryDefaultsOutPath = resolve(
    options.rootDir,
    'packages/protocol/src/providers/generated/memory/defaults.ts',
  );
  const protocolExternalSessionSourcesOutPath = resolve(
    options.rootDir,
    'packages/protocol/src/providers/generated/externalSession/sources.ts',
  );
  const protocolBuiltInBackendProfilesContributions = await collectProtocolBuiltInBackendProfilesContributions(
    pluginPackages,
    options.rootDir,
  );
  const protocolMemoryDefaultsContributions = await collectProtocolMemoryDefaultsContributions(
    pluginPackages,
    options.rootDir,
  );
  const protocolExternalSessionSourceContributions = await collectProtocolExternalSessionSourceContributions(
    pluginPackages,
    options.rootDir,
  );
  const promptAssetPluginDescriptorsOutPath = resolve(
    options.rootDir,
    'apps/cli/src/prompts/assets/generated/pluginDescriptors.ts',
  );

  const uiBehaviorOverrideSources = collectAgentUiBehaviorOverrideSources(pluginPackages);
  const sessionProviderBehaviorSources = collectAgentSessionProviderBehaviorSources(pluginPackages);
  const messageMetaOverrideSources = collectProviderMessageMetaOverrideSources(pluginPackages);
  const providerSettingsSources = collectProviderSettingsSources(pluginPackages);
  const visibleMessageResolverSources = collectVisibleMessageResolverSources(pluginPackages);
  const promptAssetContributionSources = collectPromptAssetContributionSources(pluginPackages);

  const cliOut = renderCliBundledPluginEntriesTs({ pluginPackages });

  const agentsOut = renderBundledAgentDefinitionsTs({ agentIds: bundledAgentDefinitionIds, agentDefinitionsById });
  const agentProviderIdsOut = renderAgentProviderIdsTs(agentProviderIds);
  const sessionControlAdaptersOut = renderAgentSessionControlAdaptersTs(
    collectSessionControlAdapterContributions(pluginPackages),
  );
  const runtimeDescriptorReadersOut = renderAgentRuntimeDescriptorReadersTs(
    collectRuntimeDescriptorReaderContributions(pluginPackages),
  );
  const protocolAgentProviderIdsV1Out = renderProtocolAgentProviderIdsV1Ts(
    collectProtocolAgentProviderIdsV1(agentProviderIds),
  );
  const protocolRuntimeDescriptorContributionsOut = renderProtocolRuntimeDescriptorContributionsV1Ts(
    protocolRuntimeDescriptorContributions,
  );
  const protocolBuiltInBackendProfilesOut = renderGeneratedBuiltInBackendProfilesTs(
    protocolBuiltInBackendProfilesContributions,
  );
  const protocolMemoryDefaultsOut = renderGeneratedMemoryDefaultsTs(
    protocolMemoryDefaultsContributions,
  );
  const protocolExternalSessionSourcesOut = renderGeneratedExternalSessionSourcesTs(
    protocolExternalSessionSourceContributions,
  );
  const uiOut = renderUiBundledPluginEntriesTs({ packageNames, pluginPackages });
  const uiBehaviorOverridesOut = renderBundledUiBehaviorOverridesTs(uiBehaviorOverrideSources);
  const sessionProviderBehaviorsOut = renderBundledSessionProviderBehaviorsTs(sessionProviderBehaviorSources);
  const messageMetaOverridesOut = renderBundledMessageMetaOverridesTs(messageMetaOverrideSources);
  const providerSettingsOut = renderBundledProviderSettingsTs(providerSettingsSources);
  const visibleMessageResolversOut = renderBundledVisibleMessageResolversTs(visibleMessageResolverSources);
  const promptAssetPluginDescriptorsOut = renderCliPromptAssetPluginDescriptorsTs(promptAssetContributionSources);

  if (options.mode === 'check') {
    assertGeneratedOutputMatches(cliOutPath, cliOut);
    assertGeneratedOutputMatches(agentsOutPath, agentsOut);
    assertGeneratedOutputMatches(agentProviderIdsOutPath, agentProviderIdsOut);
    assertGeneratedOutputMatches(sessionControlAdaptersOutPath, sessionControlAdaptersOut);
    assertGeneratedOutputMatches(runtimeDescriptorReadersOutPath, runtimeDescriptorReadersOut);
    assertGeneratedOutputMatches(protocolAgentProviderIdsV1OutPath, protocolAgentProviderIdsV1Out);
    assertGeneratedOutputMatches(
      protocolRuntimeDescriptorContributionsOutPath,
      protocolRuntimeDescriptorContributionsOut,
    );
    for (const output of protocolRuntimeDescriptorModuleOutputs) {
      assertGeneratedOutputMatches(output.outPath, output.out);
    }
    assertGeneratedOutputMatches(protocolBuiltInBackendProfilesOutPath, protocolBuiltInBackendProfilesOut);
    assertGeneratedOutputMatches(protocolMemoryDefaultsOutPath, protocolMemoryDefaultsOut);
    assertGeneratedOutputMatches(protocolExternalSessionSourcesOutPath, protocolExternalSessionSourcesOut);
    assertGeneratedOutputMatches(uiOutPath, uiOut);
    assertGeneratedOutputMatches(uiBehaviorOverridesOutPath, uiBehaviorOverridesOut);
    assertGeneratedOutputMatches(sessionProviderBehaviorsOutPath, sessionProviderBehaviorsOut);
    assertGeneratedOutputMatches(messageMetaOverridesOutPath, messageMetaOverridesOut);
    assertGeneratedOutputMatches(providerSettingsOutPath, providerSettingsOut);
    assertGeneratedOutputMatches(visibleMessageResolversOutPath, visibleMessageResolversOut);
    assertGeneratedOutputMatches(promptAssetPluginDescriptorsOutPath, promptAssetPluginDescriptorsOut);
    return;
  }

  writeFileAtomic(cliOutPath, cliOut);
  writeFileAtomic(agentsOutPath, agentsOut);
  writeFileAtomic(agentProviderIdsOutPath, agentProviderIdsOut);
  writeFileAtomic(sessionControlAdaptersOutPath, sessionControlAdaptersOut);
  writeFileAtomic(runtimeDescriptorReadersOutPath, runtimeDescriptorReadersOut);
  writeFileAtomic(protocolAgentProviderIdsV1OutPath, protocolAgentProviderIdsV1Out);
  writeFileAtomic(protocolRuntimeDescriptorContributionsOutPath, protocolRuntimeDescriptorContributionsOut);
  for (const output of protocolRuntimeDescriptorModuleOutputs) {
    writeFileAtomic(output.outPath, output.out);
  }
  writeFileAtomic(protocolBuiltInBackendProfilesOutPath, protocolBuiltInBackendProfilesOut);
  writeFileAtomic(protocolMemoryDefaultsOutPath, protocolMemoryDefaultsOut);
  writeFileAtomic(protocolExternalSessionSourcesOutPath, protocolExternalSessionSourcesOut);
  writeFileAtomic(uiOutPath, uiOut);
  writeFileAtomic(uiBehaviorOverridesOutPath, uiBehaviorOverridesOut);
  writeFileAtomic(sessionProviderBehaviorsOutPath, sessionProviderBehaviorsOut);
  writeFileAtomic(messageMetaOverridesOutPath, messageMetaOverridesOut);
  writeFileAtomic(providerSettingsOutPath, providerSettingsOut);
  writeFileAtomic(visibleMessageResolversOutPath, visibleMessageResolversOut);
  writeFileAtomic(promptAssetPluginDescriptorsOutPath, promptAssetPluginDescriptorsOut);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
