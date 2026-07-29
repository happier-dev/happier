import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { AgentId } from '@happier-dev/agents';
import {
  resolveWorkspaceBundleLockPath,
  withWorkspaceBundleLock,
} from '../../../packages/cli-common/workspaceBundleLock.mjs';
import {
  pluginPackageNameToPackageId,
  readBundledPluginPackageNames,
  syncCliBundledPluginMembership,
} from './bundledPluginMembership.ts';
import { readAndAssertBundledProviderVerificationsV1 } from './bundledProviderVerification.ts';

type Mode = 'write' | 'check';
type GeneratorOptions = Readonly<{ rootDir: string; mode: Mode }>;
type AgentsWorkspaceModule = typeof import('@happier-dev/agents');
type CliCommonWorkspacesModule = typeof import('@happier-dev/cli-common/workspaces');
type ProtocolWorkspaceModule = typeof import('@happier-dev/protocol');
type GeneratorWorkspaceDependencies = Readonly<{
  agents: Readonly<Pick<
    AgentsWorkspaceModule,
    | 'CANONICAL_AGENTS_CORE'
    | 'getAllAgentDefinitionContracts'
    | 'getAllBackendCatalogDefinitions'
    | 'getAllBackendDefinitionContracts'
    | 'getAgentCatalogDefinition'
    | 'getAgentCliRuntimeSpec'
  >>;
  cliCommonWorkspaces: Readonly<Pick<CliCommonWorkspacesModule, 'sanitizeBundledPackageJson'>>;
  protocol: Readonly<Pick<
    ProtocolWorkspaceModule,
    | 'BackendSurfaceOperationCatalogV1'
    | 'ConnectedServiceIdSchema'
    | 'buildQualifiedPluginContributionKey'
    | 'ingestPluginManifestV2'
  >>;
}>;

// Actual-root generation is a one-shot CLI operation. Programmatic `main` callers
// are temp-root tests and do not rebuild workspace dist within their process.
// If an in-process caller ever needs to rebuild dist between invocations, that
// lifecycle must use a fresh CLI process so Node's ESM cache cannot retain the
// prior dependency snapshot.
async function loadGeneratorWorkspaceDependencies(): Promise<GeneratorWorkspaceDependencies> {
  const [agents, cliCommonWorkspaces, protocol] = await Promise.all([
    import('@happier-dev/agents'),
    import('@happier-dev/cli-common/workspaces'),
    import('@happier-dev/protocol'),
  ]);
  return Object.freeze({
    agents: Object.freeze({
      CANONICAL_AGENTS_CORE: agents.CANONICAL_AGENTS_CORE,
      getAllAgentDefinitionContracts: agents.getAllAgentDefinitionContracts,
      getAllBackendCatalogDefinitions: agents.getAllBackendCatalogDefinitions,
      getAllBackendDefinitionContracts: agents.getAllBackendDefinitionContracts,
      getAgentCatalogDefinition: agents.getAgentCatalogDefinition,
      getAgentCliRuntimeSpec: agents.getAgentCliRuntimeSpec,
    }),
    cliCommonWorkspaces: Object.freeze({
      sanitizeBundledPackageJson: cliCommonWorkspaces.sanitizeBundledPackageJson,
    }),
    protocol: Object.freeze({
      BackendSurfaceOperationCatalogV1: protocol.BackendSurfaceOperationCatalogV1,
      ConnectedServiceIdSchema: protocol.ConnectedServiceIdSchema,
      buildQualifiedPluginContributionKey: protocol.buildQualifiedPluginContributionKey,
      ingestPluginManifestV2: protocol.ingestPluginManifestV2,
    }),
  });
}

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
  activationEvents?: readonly string[];
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
  agentUiBehaviorOverride?: AgentUiBehaviorOverrideImportSource;
  agentRuntimeContributions?: AgentRuntimeContributionsDescriptor;
  promptAssetContributions?: PromptAssetContributionSource;
  managedProviderImplementation?: ManagedProviderImplementationSource;
  builtInLegacyConnectedAccountCompatibility?:
    readonly BuiltInLegacyConnectedAccountCompatibilitySource[];
  immutableArtifact?: BundledImmutableArtifactSource;
}>;
type BuiltInLegacyConnectedAccountCompatibilitySource = Readonly<{
  legacyServiceId: string;
  serviceLocalId: string;
  peerOperations: BuiltInLegacyConnectedAccountPeerOperations;
  exactV0_2_1ReaderQuotaProjection: boolean;
  defaultAuthenticationModeId: string;
  authenticationModeByCredentialKind: Readonly<
    Partial<Record<'oauth' | 'token', string>>
  >;
  unsupportedAuthenticationModeByCredentialKind: Readonly<
    Partial<Record<'oauth' | 'token', string>>
  >;
}>;
const BUILT_IN_LEGACY_CONNECTED_ACCOUNT_OPERATION_IDS = Object.freeze([
  'account_list',
  'credential_read',
  'credential_write',
  'credential_delete',
  'credential_health',
  'refresh_lease',
  'oauth_refresh',
  'one_shot_materialization',
  'request_auth',
  'quota_read',
  'quota_refresh',
  'quota_poll',
  'recovery_credit_consume',
  'provider_account_usage_write',
] as const);
type BuiltInLegacyConnectedAccountOperation =
  typeof BUILT_IN_LEGACY_CONNECTED_ACCOUNT_OPERATION_IDS[number];
type BuiltInLegacyConnectedAccountPeerOperations = Readonly<{
  exactV0_2_1: readonly BuiltInLegacyConnectedAccountOperation[];
  revisionedV2V3: readonly BuiltInLegacyConnectedAccountOperation[];
}>;
type BuiltInLegacyConnectedAccountCompatibilityProjection = Readonly<{
  legacyServiceId: string;
  service: Readonly<{
    pluginId: string;
    localId: string;
  }>;
  peerOperations: BuiltInLegacyConnectedAccountPeerOperations;
  exactV0_2_1ReaderQuotaProjection: boolean;
  defaultAuthenticationModeId: string;
  authenticationModeByCredentialKind: Readonly<
    Partial<Record<'oauth' | 'token', string>>
  >;
  unsupportedAuthenticationModeByCredentialKind: Readonly<
    Partial<Record<'oauth' | 'token', string>>
  >;
}>;
type ManagedProviderImplementationSource = Readonly<{
  providerLocalId: string;
  facet: JsonObject;
  runtimeAdapterExportName: 'MANAGED_PROVIDER_RUNTIME_ADAPTER';
}>;
type BundledImmutableArtifactFileSource = Readonly<{
  relativePath: string;
  byteLength: number;
  digest: string;
}>;
type BundledImmutableArtifactSource = Readonly<{
  packageEntryRelativePath: string;
  record: Readonly<{
    t: 'happier_plugin_generation_v1';
    schemaVersion: 1;
    pluginId: string;
    immutableGenerationId: string;
    fingerprint: string;
    packageDigest: string;
    manifestDigest: string;
    runtimeDigest: string;
    installedUiArtifactDigest: string;
    createdAtMs: number;
    files: readonly BundledImmutableArtifactFileSource[];
    installedArtifactRecord: Readonly<{ relativePath: string; digest: string }>;
  }>;
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
      cliGlyph: string;
      cliGlyphScale: number;
      profileCompatibilityGlyphScale: number;
    }>;
    avatarOverlay: Readonly<{
      circleScale: number;
      iconScaleRatio: number;
    }>;
    icon?: Readonly<{ assetId: string | null }>;
  }>;
  behavior?: JsonObject;
  session?: JsonObject;
  message?: JsonObject;
  components?: JsonObject;
  assets?: JsonObject;
}>;
type AgentRuntimeContributionsDescriptor = Readonly<{
  agentCatalogEntry?: AgentRuntimeProjectionImportDescriptor;
  sessionControlAdapter?: SessionControlAdapterContributionDescriptor;
  runtimeDescriptorReader?: RuntimeDescriptorReaderContributionDescriptor;
  protocolRuntimeDescriptor?: ProtocolRuntimeDescriptorContributionDescriptor;
  protocolBuiltInBackendProfiles?: ProtocolBuiltInBackendProfilesContributionDescriptor;
  protocolMemoryDefaults?: ProtocolMemoryDefaultsContributionDescriptor;
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
  agentId: string;
  candidateHostAdapter?: RuntimeProjectionExportDescriptor;
  transcriptStoreAdapter?: RuntimeProjectionExportDescriptor;
}>;
type RuntimeDescriptorResumeIdSessionControlContributionDescriptor = Readonly<{
  kind: 'runtimeDescriptorResumeId';
  agentId: string;
  absolutePathField?: string;
  fallbackField: string;
}>;
type ProviderSessionControlAdapterContributionDescriptor = Readonly<{
  kind: 'providerSessionControlAdapter';
  agentId: string;
  source: string;
  exportName: string;
  generatedAdapter: JsonObject;
}>;
type SessionControlAdapterContributionDescriptor =
  | RuntimeDescriptorResumeIdSessionControlContributionDescriptor
  | ProviderSessionControlAdapterContributionDescriptor;
type ProviderSessionIdRuntimeDescriptorReaderContributionDescriptor = Readonly<{
  kind: 'providerSessionId';
  agentId: string;
  runtimeHandle: 'providerSessionId';
}>;
type ProviderRuntimeDescriptorReaderContributionDescriptor = Readonly<{
  kind: 'providerRuntimeDescriptorReader';
  agentId: string;
  source: string;
  exportName: string;
  generatedReader: JsonObject;
}>;
type RuntimeDescriptorReaderContributionDescriptor =
  | ProviderSessionIdRuntimeDescriptorReaderContributionDescriptor
  | ProviderRuntimeDescriptorReaderContributionDescriptor;
type ProtocolRuntimeDescriptorContributionDescriptor = Readonly<{
  kind: 'providerRuntimeDescriptorV1';
  agentId: string;
  source: string;
  buildFunction: string;
  canonicalReader: string;
}>;
type ProtocolBuiltInBackendProfilesContributionDescriptor = Readonly<{
  kind: 'providerBuiltInBackendProfilesV1';
  agentId: string;
  source: string;
  exportName: string;
}>;
type ProtocolMemoryDefaultsContributionDescriptor = Readonly<{
  kind: 'providerMemoryDefaultsV1';
  agentId: string;
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
type ExternalSessionInstanceConstantDescriptor = string | number | boolean | null;
type ExternalSessionInstanceDescriptor =
  | Readonly<{
    kind: 'default';
    constants: Readonly<Record<string, ExternalSessionInstanceConstantDescriptor>>;
  }>
  | Readonly<{
    kind: 'connectedServiceProfiles';
    serviceId: string;
    constants: Readonly<Record<string, ExternalSessionInstanceConstantDescriptor>>;
    fields: Readonly<{ serviceId: string; profileId: string }>;
  }>;
type ExternalSessionSourceDeclaration = Readonly<{
  agentId: string;
  sourceKind: string;
  schema: Readonly<{
    passthrough?: boolean;
    fields: readonly ExternalSessionSchemaFieldDescriptor[];
    refinements?: readonly ExternalSessionSchemaRefinementDescriptor[];
  }>;
  key: Readonly<{
    segments: readonly ExternalSessionKeySegmentDescriptor[];
  }>;
  instances?: readonly ExternalSessionInstanceDescriptor[];
}>;
type ProtocolExternalSessionSourceProjectionDescriptor = Readonly<{
  agentId: string;
  declaration: ExternalSessionSourceDeclaration;
}>;
type AgentCommandSurfaceSource = Readonly<{
  rootHelpLabel?: string;
  rootHelpDescription?: string;
  rootHelpDetail?: string;
  allowTmux?: boolean;
}>;
type AgentCommandPolicySource = Readonly<{
  daemonAutostartDefault?: 'preferLocalTui';
}>;
type BuiltInProviderContributionSource = Readonly<{
  id: string;
  definition: JsonValue;
  runtimeSpec: JsonValue;
  cliSubcommand: string;
  vendorResumeSupport: string;
  commandSurface?: AgentCommandSurfaceSource;
  commandPolicy?: AgentCommandPolicySource;
}>;
type BuiltInBackendContributionSource = Readonly<{
  id: string;
  agentId: string;
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
  providerOwnedEnvironmentKeys: readonly string[];
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
  behaviorOverride?: AgentUiBehaviorOverrideImportSource;
}>;
type AgentUiBehaviorOverrideImportSource = Readonly<{
  importName: string;
  importPath: string;
}>;
type AgentSessionBehaviorSource = Readonly<{
  agentId: string;
  descriptor: JsonObject;
}>;
type SessionSubagentVisibleMessageResolverSource = Readonly<{
  agentId: string;
  descriptor: JsonObject;
}>;
type AgentCatalogEntryHookSource = Readonly<{
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
type BundledFirstPartyVoiceProjectionSource = Readonly<{
  packageName: string;
  packageVersion: string;
  pluginId: string;
  pluginPackageId: BundledFirstPartyVoicePackageId;
  hasConversationProvider: boolean;
  conversationPlatforms: readonly BundledVoiceRuntimePlatform[];
}>;
type BundledFirstPartyVoicePackageId = 'codex' | 'elevenlabs' | 'google' | 'openai' | 'xai';
type BundledVoiceRuntimePlatform = 'web' | 'ios' | 'android';

const BUNDLED_VOICE_RUNTIME_PLATFORMS = Object.freeze([
  'web',
  'ios',
  'android',
] as const satisfies readonly BundledVoiceRuntimePlatform[]);

const BUNDLED_FIRST_PARTY_VOICE_PLUGIN_IDS: Readonly<Record<BundledFirstPartyVoicePackageId, string>> = Object.freeze({
  codex: 'happier.agent.codex',
  elevenlabs: 'happier.voice.elevenlabs',
  google: 'happier.voice.google',
  openai: 'happier.voice.openai',
  xai: 'happier.voice.xai',
});
const BUNDLED_FIRST_PARTY_VOICE_PACKAGE_IDS = Object.freeze(
  Object.keys(BUNDLED_FIRST_PARTY_VOICE_PLUGIN_IDS) as BundledFirstPartyVoicePackageId[],
);

const GENERATED_AGENT_UI_PROJECTION_SOURCES: readonly GeneratedAgentUiProjectionSource[] = Object.freeze([
  // Remove this legacy host projection once Qwen ships a first-party plugin.ui.v1 descriptor.
  { agentId: 'qwen', coreConst: 'QWEN_CORE', uiConst: 'QWEN_UI', renderLines: renderQwenGeneratedUiProjectionLines },
]);
const AGENT_UI_PROJECTION_ORDER = Object.freeze([
  'claude',
  'codex',
  'cursor',
  'opencode',
  'antigravity',
  'gemini',
  'grok',
  'auggie',
  'qwen',
  'kimi',
  'kilo',
  'kiro',
  'pi',
  'ohMyPi',
  'copilot',
  'coderabbit',
  'deepsec',
]);
const STABLE_AGENT_ID_ORDER = Object.freeze([
  'claude',
  'codex',
  'opencode',
  'antigravity',
  'gemini',
  'grok',
  'auggie',
  'qwen',
  'kimi',
  'kilo',
  'kiro',
  'cursor',
  'ohMyPi',
  'pi',
  'copilot',
  'coderabbit',
  'deepsec',
] as const);
const PROTOCOL_AGENT_PROVIDER_IDS_V1 = Object.freeze([
  'claude',
  'codex',
  'opencode',
  'antigravity',
  'pi',
  'ohMyPi',
] as const);
function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function isBundledFirstPartyVoicePackageId(value: string): value is BundledFirstPartyVoicePackageId {
  return Object.prototype.hasOwnProperty.call(BUNDLED_FIRST_PARTY_VOICE_PLUGIN_IDS, value);
}

function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  // Migration scripts run single-process; an atomic rename dance is overkill here.
  writeFileSync(path, content, 'utf8');
}

function parseCliArgs(argv: readonly string[]): GeneratorOptions {
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
  const loaderPath = fileURLToPath(new URL('./readTypescriptModule.mjs', import.meta.url));
  const outputMarker = '__HAPPIER_GENERATOR_MODULE_JSON__';
  const result = spawnSync(process.execPath, ['--max-old-space-size=2048', loaderPath, path], {
    encoding: 'utf8',
    killSignal: 'SIGKILL',
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180_000,
  });
  if (result.error) {
    throw new Error(`Failed to inspect TypeScript module ${path}: ${result.error.message}`);
  }
  if (result.signal || result.status !== 0) {
    const detail = result.stderr.trim();
    throw new Error(
      detail
        ? `Failed to inspect TypeScript module ${path}: ${detail}`
        : `Failed to inspect TypeScript module ${path}`,
    );
  }
  const markerIndex = result.stdout.lastIndexOf(outputMarker);
  if (markerIndex < 0) {
    throw new Error(`Failed to inspect TypeScript module ${path}: missing isolated module result`);
  }
  const payload = JSON.parse(result.stdout.slice(markerIndex + outputMarker.length)) as unknown;
  if (!isRecord(payload) || !Array.isArray(payload.exportNames) || !isRecord(payload.values)) {
    throw new Error(`Failed to inspect TypeScript module ${path}: invalid isolated module result`);
  }
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const exportName of payload.exportNames) {
    if (typeof exportName !== 'string') {
      throw new Error(`Failed to inspect TypeScript module ${path}: invalid export name`);
    }
    out[exportName] = payload.values[exportName];
  }
  return out;
}

function readManifestContributionArray(manifest: PluginManifestJson, family: string): readonly JsonValue[] {
  const contributes = manifest.contributes;
  if (!isRecord(contributes)) return [];
  const value = contributes[family];
  return Array.isArray(value) ? value : [];
}

function readManifestNestedContributionArray(
  manifest: PluginManifestJson,
  family: string,
  nestedFamily: string,
): readonly JsonValue[] {
  const contributes = manifest.contributes;
  if (!isRecord(contributes)) return [];
  const familyContributions = contributes[family];
  if (!isRecord(familyContributions)) return [];
  const value = familyContributions[nestedFamily];
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

function readBackendContributionProviderId(
  value: JsonValue,
  family: string,
  pluginPackageId: string,
): string {
  const providerId = readOptionalJsonStringProperty(value, 'providerId');
  const legacyAgentId = readOptionalJsonStringProperty(value, 'agentId');
  if (providerId && legacyAgentId && providerId !== legacyAgentId) {
    throw new Error(`Invalid ${family} contribution in ${pluginPackageId}: providerId and legacy agentId must match`);
  }
  const resolvedProviderId = providerId ?? legacyAgentId;
  if (!resolvedProviderId) {
    throw new Error(`Invalid ${family} contribution in ${pluginPackageId}: expected object with non-empty string providerId`);
  }
  return resolvedProviderId;
}

function assertUniqueBundledContributionIds(
  family: string,
  contributions: readonly BundledManifestContribution[],
): void {
  const seen = new Map<string, BundledManifestContribution>();
  for (const contribution of contributions) {
    const existing = seen.get(contribution.id);
    if (existing) {
      throw new Error(
        `Duplicate bundled first-party ${family} contribution '${contribution.id}'`
        + ` from ${contribution.metadata.pluginPackageId}; already declared by ${existing.metadata.pluginPackageId}`,
      );
    }
    seen.set(contribution.id, contribution);
  }
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

function hasTerminalRuntimeLaunchSurfaceContribution(
  definition: JsonValue,
  dependencies: GeneratorWorkspaceDependencies,
): boolean {
  return readJsonArrayProperty(definition, 'surfaceHandlers').some((surfaceHandler) => (
    isJsonObject(surfaceHandler)
    && surfaceHandler.kind === 'terminalRuntime'
    && surfaceHandler.operation === dependencies.protocol.BackendSurfaceOperationCatalogV1.terminalRuntime.launch
  ));
}

function isProviderlessReviewExecutionRunBackendContribution(
  definition: JsonValue,
  dependencies: GeneratorWorkspaceDependencies,
): boolean {
  const capabilities = readJsonObjectProperty(definition, 'capabilities');
  const session = capabilities ? readJsonObjectProperty(capabilities, 'session') : null;
  const executionRun = capabilities ? readJsonObjectProperty(capabilities, 'executionRun') : null;
  return session?.supported === false
    && executionRun !== null
    && executionRun.supported !== false
    && isJsonObject(executionRun.review)
    && !hasTerminalRuntimeLaunchSurfaceContribution(definition, dependencies);
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
      agentId: readRequiredString(contribution, 'providerId', `${path}.sessionControlAdapter`),
      source: readRequiredString(contribution, 'source', `${path}.sessionControlAdapter`),
      exportName: readRequiredString(contribution, 'exportName', `${path}.sessionControlAdapter`),
      generatedAdapter: readOptionalJsonObjectDescriptor(
        contribution,
        'generatedAdapter',
        `${path}.sessionControlAdapter`,
      ) ?? (() => {
        throw new Error(`Invalid agent runtime contribution at ${path}.sessionControlAdapter.generatedAdapter: expected object`);
      })(),
    };
  }
  if (kind !== 'runtimeDescriptorResumeId') {
    throw new Error(
      `Invalid agent runtime contribution at ${path}.sessionControlAdapter.kind: expected runtimeDescriptorResumeId or providerSessionControlAdapter`,
    );
  }
  return {
    kind,
    agentId: readRequiredString(contribution, 'providerId', `${path}.sessionControlAdapter`),
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
      agentId: readRequiredString(contribution, 'providerId', `${path}.runtimeDescriptorReader`),
      source: readRequiredString(contribution, 'source', `${path}.runtimeDescriptorReader`),
      exportName: readRequiredString(contribution, 'exportName', `${path}.runtimeDescriptorReader`),
      generatedReader: readOptionalJsonObjectDescriptor(
        contribution,
        'generatedReader',
        `${path}.runtimeDescriptorReader`,
      ) ?? (() => {
        throw new Error(`Invalid agent runtime contribution at ${path}.runtimeDescriptorReader.generatedReader: expected object`);
      })(),
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
    agentId: readRequiredString(contribution, 'providerId', `${path}.runtimeDescriptorReader`),
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
    agentId: readRequiredString(contribution, 'providerId', `${path}.protocolRuntimeDescriptor`),
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
    agentId: readRequiredString(contribution, 'providerId', `${path}.protocolBuiltInBackendProfiles`),
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
    agentId: readRequiredString(contribution, 'providerId', `${path}.protocolMemoryDefaults`),
    source: readRequiredString(contribution, 'source', `${path}.protocolMemoryDefaults`),
    exportName: readRequiredString(contribution, 'exportName', `${path}.protocolMemoryDefaults`),
  };
}

function rejectRetiredProtocolExternalSessionSourceContribution(
  record: Record<string, unknown>,
  path: string,
): void {
  if (record.protocolExternalSessionSource === undefined) return;
  throw new Error(
    `Invalid agent runtime contribution at ${path}.protocolExternalSessionSource: declare external-session source schemas at manifest.contributes.agents[].surfaces.externalSession.sources[]`,
  );
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
    agentId: readRequiredString(contribution, 'providerId', `${path}.externalSessionHostAdapters`),
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
  const agentCatalogEntry = readOptionalAgentRuntimeProjectionImportDescriptor(
    runtimeContributions,
    'agentCatalogEntry',
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
  rejectRetiredProtocolExternalSessionSourceContribution(
    runtimeContributions,
    `${definitionPath}.runtimeContributions`,
  );
  const externalSessionHostAdapters = readOptionalExternalSessionHostAdaptersContribution(
    runtimeContributions,
    `${definitionPath}.runtimeContributions`,
  );
  return {
    ...(agentCatalogEntry === undefined ? {} : { agentCatalogEntry }),
    ...(sessionControlAdapter === undefined ? {} : { sessionControlAdapter }),
    ...(runtimeDescriptorReader === undefined ? {} : { runtimeDescriptorReader }),
    ...(protocolRuntimeDescriptor === undefined ? {} : { protocolRuntimeDescriptor }),
    ...(protocolBuiltInBackendProfiles === undefined ? {} : { protocolBuiltInBackendProfiles }),
    ...(protocolMemoryDefaults === undefined ? {} : { protocolMemoryDefaults }),
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

  const importName = `${toAgentConstPrefix(agentId)}_AGENT_RUNTIME_CONTRIBUTION`;
  const mod = await importTypescriptModule(sourcePath) as Record<string, unknown>;
  if (!(importName in mod)) {
    throw new Error(`Expected ${importName} export in ${sourcePath}`);
  }

  return {
    agentCatalogEntry: {
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
  const nameKey = readRequiredString(display, 'nameKey', `${descriptorPath}.display`);
  const connectedServiceLabelKey = readRequiredString(
    connectedService,
    'labelKey',
    `${descriptorPath}.display.connectedService`,
  );
  const cliGlyph = readRequiredString(picker, 'cliGlyph', `${descriptorPath}.display.picker`);
  if (
    cliGlyph.trim() !== cliGlyph
    || Array.from(cliGlyph).length < 1
    || Array.from(cliGlyph).length > 8
    || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(cliGlyph)
  ) {
    throw new Error(
      `Invalid agent UI descriptor at ${descriptorPath}.display.picker.cliGlyph: expected 1 to 8 Unicode code points without surrounding whitespace or control characters`,
    );
  }

  return {
    kind,
    pluginId: readRequiredString(root, 'pluginId', descriptorPath),
    agentId: readRequiredString(root, 'agentId', descriptorPath),
    version: readRequiredNumber(root, 'version', descriptorPath),
    display: {
      nameKey,
      subtitleKey: readRequiredString(display, 'subtitleKey', `${descriptorPath}.display`),
      permissionModeI18nPrefix: readRequiredString(display, 'permissionModeI18nPrefix', `${descriptorPath}.display`),
      availability: {
        experimental: readRequiredBoolean(availability, 'experimental', `${descriptorPath}.display.availability`),
      },
      connectedService: {
        serviceId: readNullableString(connectedService, 'serviceId', `${descriptorPath}.display.connectedService`),
        labelKey: connectedServiceLabelKey,
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
        cliGlyph,
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

async function loadManagedProviderImplementation(
  repoRoot: string,
  pluginPackageId: string,
  manifest: PluginManifestJson,
): Promise<ManagedProviderImplementationSource | undefined> {
  const implementationPath = resolve(repoRoot, 'packages/plugins', pluginPackageId, 'src/managed.ts');
  if (!existsSync(implementationPath)) return undefined;

  const mod = await importTypescriptModule(implementationPath) as Record<string, unknown>;
  const raw = mod.MANAGED_PROVIDER_IMPLEMENTATION;
  const runtimeAdapter = mod.MANAGED_PROVIDER_RUNTIME_ADAPTER;
  const normalized = readJsonSerializableValue(
    raw,
    `${pluginPackageId}.MANAGED_PROVIDER_IMPLEMENTATION`,
  );
  if (!isJsonObject(normalized)) {
    throw new Error(`Invalid MANAGED_PROVIDER_IMPLEMENTATION in ${implementationPath}: expected object`);
  }
  if (
    !isRecord(runtimeAdapter)
    // The isolated module inspector intentionally transports JSON only, so callback
    // properties are omitted here. The generated import and host projection validate
    // the live exact prepare/endpoint adapter.
    || Reflect.ownKeys(runtimeAdapter).length !== 2
    || runtimeAdapter.v !== 1
    || !isJsonObject(runtimeAdapter.catalogSource)
    || Object.keys(runtimeAdapter.catalogSource).length !== 3
    || runtimeAdapter.catalogSource.kind !== 'transientModelEndpoint'
    || typeof runtimeAdapter.catalogSource.contractVersion !== 'string'
    || runtimeAdapter.catalogSource.contractVersion.trim() !== runtimeAdapter.catalogSource.contractVersion
    || runtimeAdapter.catalogSource.contractVersion.length === 0
    || typeof runtimeAdapter.catalogSource.sdkVersion !== 'string'
    || runtimeAdapter.catalogSource.sdkVersion.trim() !== runtimeAdapter.catalogSource.sdkVersion
    || runtimeAdapter.catalogSource.sdkVersion.length === 0
  ) {
    throw new Error(
      `Invalid MANAGED_PROVIDER_RUNTIME_ADAPTER in ${implementationPath}: expected strict v1 adapter export`,
    );
  }
  const keys = Object.keys(normalized).sort();
  if (
    keys.length !== 3
    || keys[0] !== 'facet'
    || keys[1] !== 'providerLocalId'
    || keys[2] !== 'v'
    || normalized.v !== 1
    || typeof normalized.providerLocalId !== 'string'
    || !isJsonObject(normalized.facet)
  ) {
    throw new Error(
      `Invalid MANAGED_PROVIDER_IMPLEMENTATION in ${implementationPath}: expected strict v1 descriptor`,
    );
  }
  const providerLocalId = normalized.providerLocalId.trim();
  if (!providerLocalId || providerLocalId !== normalized.providerLocalId) {
    throw new Error(
      `Invalid MANAGED_PROVIDER_IMPLEMENTATION in ${implementationPath}: providerLocalId must be canonical`,
    );
  }
  const manifestProviders = readManifestContributionArray(manifest, 'providers');
  const matchingProviders = manifestProviders.filter(
    (provider) => readRequiredContributionId(provider, 'providers', pluginPackageId) === providerLocalId,
  );
  if (matchingProviders.length !== 1) {
    throw new Error(
      `Invalid MANAGED_PROVIDER_IMPLEMENTATION in ${implementationPath}: Provider '${providerLocalId}' is not declared exactly once`,
    );
  }
  return Object.freeze({
    providerLocalId,
    facet: normalized.facet,
    runtimeAdapterExportName: 'MANAGED_PROVIDER_RUNTIME_ADAPTER',
  });
}

async function loadBuiltInLegacyConnectedAccountCompatibility(
  repoRoot: string,
  pluginPackageId: string,
): Promise<readonly BuiltInLegacyConnectedAccountCompatibilitySource[] | undefined> {
  const sourcePath = resolve(
    repoRoot,
    'packages/plugins',
    pluginPackageId,
    'src/connectedAccounts/builtInLegacyCompatibility.ts',
  );
  if (!existsSync(sourcePath)) return undefined;

  const mod = await importTypescriptModule(sourcePath) as Record<string, unknown>;
  if (
    Reflect.ownKeys(mod).length !== 1
    || !Object.prototype.hasOwnProperty.call(
      mod,
      'BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY',
    )
  ) {
    throw new Error(
      `Invalid built-in legacy Connected Account compatibility in ${sourcePath}: expected exactly BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY`,
    );
  }
  const raw = mod.BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      `Invalid built-in legacy Connected Account compatibility in ${sourcePath}: expected a non-empty array`,
    );
  }
  const seen = new Set<string>();
  const operationIds = new Set<string>(
    BUILT_IN_LEGACY_CONNECTED_ACCOUNT_OPERATION_IDS,
  );
  const readPeerOperations = (
    value: unknown,
  ): BuiltInLegacyConnectedAccountPeerOperations | null => {
    if (
      !isRecord(value)
      || Reflect.ownKeys(value).some((key) =>
        typeof key !== 'string'
        || !['exactV0_2_1', 'revisionedV2V3'].includes(key))
      || Reflect.ownKeys(value).length !== 2
      || !Array.isArray(value.exactV0_2_1)
      || !Array.isArray(value.revisionedV2V3)
    ) {
      return null;
    }
    const normalize = (
      operations: unknown[],
    ): readonly BuiltInLegacyConnectedAccountOperation[] | null => {
      if (
        operations.some((operation) =>
          typeof operation !== 'string'
          || !operationIds.has(operation))
        || new Set(operations).size !== operations.length
      ) {
        return null;
      }
      return Object.freeze(
        [...operations] as BuiltInLegacyConnectedAccountOperation[],
      );
    };
    const exactV0_2_1 = normalize(value.exactV0_2_1);
    const revisionedV2V3 = normalize(value.revisionedV2V3);
    return exactV0_2_1 && revisionedV2V3
      ? Object.freeze({ exactV0_2_1, revisionedV2V3 })
      : null;
  };
  return Object.freeze(raw.map((entry, index) => {
    const peerOperations =
      isRecord(entry)
        ? readPeerOperations(entry.peerOperations)
        : null;
    if (
      !isRecord(entry)
      || Reflect.ownKeys(entry).some((key) =>
        typeof key !== 'string'
        || ![
          'legacyServiceId',
          'serviceLocalId',
          'peerOperations',
          'exactV0_2_1ReaderQuotaProjection',
          'defaultAuthenticationModeId',
          'authenticationModeByCredentialKind',
          'unsupportedAuthenticationModeByCredentialKind',
        ].includes(key))
      || typeof entry.legacyServiceId !== 'string'
      || typeof entry.serviceLocalId !== 'string'
      || peerOperations === null
      || typeof entry.exactV0_2_1ReaderQuotaProjection !== 'boolean'
      || typeof entry.defaultAuthenticationModeId !== 'string'
      || !isRecord(entry.authenticationModeByCredentialKind)
      || Reflect.ownKeys(entry.authenticationModeByCredentialKind)
        .some((kind) => kind !== 'oauth' && kind !== 'token')
      || Reflect.ownKeys(entry.authenticationModeByCredentialKind).length === 0
      || Object.values(entry.authenticationModeByCredentialKind)
        .some((modeId) => typeof modeId !== 'string'
          || modeId.length === 0
          || modeId.trim() !== modeId)
      || (
        entry.unsupportedAuthenticationModeByCredentialKind !== undefined
        && (
          !isRecord(entry.unsupportedAuthenticationModeByCredentialKind)
          || Reflect.ownKeys(entry.unsupportedAuthenticationModeByCredentialKind)
            .some((kind) => kind !== 'oauth' && kind !== 'token')
          || Reflect.ownKeys(entry.unsupportedAuthenticationModeByCredentialKind)
            .length === 0
          || Object.values(entry.unsupportedAuthenticationModeByCredentialKind)
            .some((modeId) => typeof modeId !== 'string'
              || modeId.length === 0
              || modeId.trim() !== modeId)
          || Reflect.ownKeys(entry.unsupportedAuthenticationModeByCredentialKind)
            .some((kind) =>
              Object.prototype.hasOwnProperty.call(
                entry.authenticationModeByCredentialKind,
                kind,
              ))
        )
      )
      || entry.legacyServiceId.trim() !== entry.legacyServiceId
      || entry.serviceLocalId.trim() !== entry.serviceLocalId
      || entry.defaultAuthenticationModeId.trim()
        !== entry.defaultAuthenticationModeId
      || entry.legacyServiceId.length === 0
      || entry.serviceLocalId.length === 0
      || entry.defaultAuthenticationModeId.length === 0
      || seen.has(entry.legacyServiceId)
    ) {
      throw new Error(
        `Invalid built-in legacy Connected Account compatibility entry ${index} in ${sourcePath}`,
      );
    }
    seen.add(entry.legacyServiceId);
    return Object.freeze({
      legacyServiceId: entry.legacyServiceId,
      serviceLocalId: entry.serviceLocalId,
      peerOperations,
      exactV0_2_1ReaderQuotaProjection:
        entry.exactV0_2_1ReaderQuotaProjection,
      defaultAuthenticationModeId: entry.defaultAuthenticationModeId,
      authenticationModeByCredentialKind: Object.freeze({
        ...(typeof entry.authenticationModeByCredentialKind.oauth === 'string'
          ? { oauth: entry.authenticationModeByCredentialKind.oauth }
          : {}),
        ...(typeof entry.authenticationModeByCredentialKind.token === 'string'
          ? { token: entry.authenticationModeByCredentialKind.token }
          : {}),
      }),
      unsupportedAuthenticationModeByCredentialKind: Object.freeze({
        ...(isRecord(entry.unsupportedAuthenticationModeByCredentialKind)
          && typeof entry.unsupportedAuthenticationModeByCredentialKind.oauth
            === 'string'
          ? { oauth: entry.unsupportedAuthenticationModeByCredentialKind.oauth }
          : {}),
        ...(isRecord(entry.unsupportedAuthenticationModeByCredentialKind)
          && typeof entry.unsupportedAuthenticationModeByCredentialKind.token
            === 'string'
          ? { token: entry.unsupportedAuthenticationModeByCredentialKind.token }
          : {}),
      }),
    });
  }));
}

function normalizeAgentDefinitionForAgentsOutput(definition: JsonValue): JsonValue {
  if (!isRecord(definition)) return definition;
  const legacyCliAuthorityFields = [
    'providerCliRuntime',
    'agentCliRuntime',
    'authProbeConfig',
    'localCli',
  ].filter((field) => definition[field] !== undefined);
  if (legacyCliAuthorityFields.length > 0) {
    throw new Error(
      `AGENT_DEFINITION.${legacyCliAuthorityFields.join(', AGENT_DEFINITION.')} `
      + 'is no longer accepted; use contributes.agents[].cli',
    );
  }
  return definition;
}

function readNativeAgentCliMetadata(
  manifest: JsonValue,
  agentId: string,
): JsonObject | null {
  const contributions = readManifestContributionArray(manifest, 'agents');
  const contribution = contributions.find((entry) => (
    isJsonObject(entry) && entry.id === agentId
  )) ?? (contributions.length === 1 ? contributions[0] : null);
  return contribution ? readJsonObjectProperty(contribution, 'cli') : null;
}

function readNativeAgentContributionTitle(
  manifest: JsonValue,
  agentId: string,
  pluginPackageId: string,
): string {
  const contributions = readManifestContributionArray(manifest, 'agents');
  const contribution = contributions.find((entry) => (
    isJsonObject(entry) && entry.id === agentId
  )) ?? (contributions.length === 1 ? contributions[0] : null);
  if (!contribution) {
    throw new Error(`Missing native Agent contribution for ${pluginPackageId}.${agentId}`);
  }

  if (typeof contribution.title === 'string' && contribution.title.trim().length > 0) {
    return contribution.title;
  }
  const localizedTitle = readJsonObjectProperty(contribution, 'title');
  if (localizedTitle && typeof localizedTitle.fallback === 'string' && localizedTitle.fallback.trim().length > 0) {
    return localizedTitle.fallback;
  }
  throw new Error(
    `Invalid Agent title at ${pluginPackageId}.contributes.agents.${agentId}.title: expected a non-empty string or localized fallback`,
  );
}

function projectNativeAgentCliDefinitionFacts(
  definition: JsonValue,
  manifest: JsonValue,
  pluginPackageId: string,
): JsonValue {
  if (!isJsonObject(definition) || typeof definition.id !== 'string') return definition;
  const cli = readNativeAgentCliMetadata(manifest, definition.id);
  if (!cli) {
    throw new Error(
      `Invalid ${pluginPackageId}.${definition.id}: strict native Agent CLI/auth metadata is required`,
    );
  }
  return {
    ...definition,
    cli: {
      ...cli,
      displayName: typeof cli.displayName === 'string'
        ? cli.displayName
        : readNativeAgentContributionTitle(manifest, definition.id, pluginPackageId),
    },
  };
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

function readOptionalAgentCommandPolicySource(
  definition: JsonValue,
  pluginPackageId: string,
): AgentCommandPolicySource | undefined {
  const commandPolicy = readJsonObjectProperty(definition, 'commandPolicy');
  if (!commandPolicy) return undefined;

  const daemonAutostartDefault = readOptionalJsonStringProperty(commandPolicy, 'daemonAutostartDefault') ?? undefined;
  if (
    daemonAutostartDefault !== undefined
    && daemonAutostartDefault !== 'preferLocalTui'
  ) {
    throw new Error(
      `Invalid AGENT_DEFINITION.commandPolicy for ${pluginPackageId}: daemonAutostartDefault must be 'preferLocalTui' when present`,
    );
  }

  if (daemonAutostartDefault === undefined) {
    return undefined;
  }

  return { daemonAutostartDefault };
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

function collectAgentCommandPolicySources(
  pluginPackages: readonly BundledPluginPackage[],
): ReadonlyMap<string, AgentCommandPolicySource> {
  return new Map(
    pluginPackages.flatMap((entry) => {
      const definition = entry.agentDefinition;
      if (!isJsonObject(definition)) return [];

      const agentId = typeof definition.id === 'string' ? definition.id : entry.agentId;
      if (!agentId) return [];

      const commandPolicy = readOptionalAgentCommandPolicySource(definition, entry.pluginPackageId);
      return commandPolicy ? [[agentId, commandPolicy] as const] : [];
    }),
  );
}

function collectBuiltInProviderContributionSources(
  pluginPackages: readonly BundledPluginPackage[],
  dependencies: GeneratorWorkspaceDependencies,
): readonly BuiltInProviderContributionSource[] {
  const commandSurfaceByAgentId = collectAgentCommandSurfaceSources(pluginPackages);
  const commandPolicyByAgentId = collectAgentCommandPolicySources(pluginPackages);
  const manifestAgentContributionsById = new Map<string, Readonly<{
    definition: JsonValue;
    pluginPackageId: string;
  }>>();
  for (const entry of pluginPackages) {
    for (const agentContribution of readManifestContributionArray(entry.manifest, 'agents')) {
      const agentId = readRequiredContributionId(agentContribution, 'agents', entry.pluginPackageId);
      const existing = manifestAgentContributionsById.get(agentId);
      if (existing) {
        throw new Error(
          `Duplicate bundled plugin agent contribution '${agentId}' from ${entry.pluginPackageId}; already declared by ${existing.pluginPackageId}`,
        );
      }
      manifestAgentContributionsById.set(agentId, {
        definition: agentContribution,
        pluginPackageId: entry.pluginPackageId,
      });
    }
  }
  const existingSources = dependencies.agents.getAllAgentDefinitionContracts()
    .map((definition) => {
    const providerId = definition.id as AgentId;
    const richDefinition = dependencies.agents.getAgentCatalogDefinition(providerId);
    if (!richDefinition) {
      throw new Error(`Missing built-in provider catalog definition '${definition.id}'`);
    }
    const canonicalDefinition = readJsonSerializableValue(
      definition,
      `provider.${definition.id}.definition`,
    );
    if (!isJsonObject(canonicalDefinition)) {
      throw new Error(`Invalid built-in agent definition '${definition.id}'`);
    }
    if (Object.prototype.hasOwnProperty.call(canonicalDefinition, 'providerRequirements')) {
      throw new Error(
        `Built-in agent definition '${definition.id}' must not duplicate manifest-owned providerRequirements`,
      );
    }
    const manifestSource = manifestAgentContributionsById.get(definition.id);
    let generatedDefinition: JsonObject = canonicalDefinition;
    if (manifestSource) {
      const providerRequirements = readJsonObjectProperty(manifestSource.definition, 'providerRequirements');
      if (providerRequirements) {
        generatedDefinition = {
          ...canonicalDefinition,
          providerRequirements: readJsonSerializableValue(
            providerRequirements,
            `${manifestSource.pluginPackageId}.contributes.agents.${definition.id}.providerRequirements`,
          ),
        };
      }
    }
    return {
      id: definition.id,
      definition: generatedDefinition,
      runtimeSpec: readJsonSerializableValue(
        dependencies.agents.getAgentCliRuntimeSpec(providerId),
        `provider.${definition.id}.runtimeSpec`,
      ),
      cliSubcommand: richDefinition.core.cliSubcommand,
      vendorResumeSupport: richDefinition.core.resume.vendorResume,
      ...(commandSurfaceByAgentId.has(definition.id)
        ? { commandSurface: commandSurfaceByAgentId.get(definition.id) }
        : {}),
      ...(commandPolicyByAgentId.has(definition.id)
        ? { commandPolicy: commandPolicyByAgentId.get(definition.id) }
        : {}),
    };
  });
  const existingIds = new Set(existingSources.map((source) => source.id));
  const pluginSources = collectPluginAgentContributionSources(
    pluginPackages,
    existingIds,
    commandSurfaceByAgentId,
    commandPolicyByAgentId,
  );
  return [...existingSources, ...pluginSources];
}

function collectPluginAgentContributionSources(
  pluginPackages: readonly BundledPluginPackage[],
  existingIds: ReadonlySet<string>,
  commandSurfaceByAgentId: ReadonlyMap<string, AgentCommandSurfaceSource>,
  commandPolicyByAgentId: ReadonlyMap<string, AgentCommandPolicySource>,
): readonly BuiltInProviderContributionSource[] {
  const out: BuiltInProviderContributionSource[] = [];
  const seen = new Set<string>();

  for (const entry of pluginPackages) {
    for (const agentContribution of readManifestContributionArray(entry.manifest, 'agents')) {
      const agentId = readRequiredContributionId(agentContribution, 'agents', entry.pluginPackageId);
      if (existingIds.has(agentId)) continue;
      if (seen.has(agentId)) {
        throw new Error(`Duplicate bundled plugin agent contribution '${agentId}'`);
      }

      const richDefinition = entry.agentId === agentId && isJsonObject(entry.agentDefinition)
        ? entry.agentDefinition
        : null;
      const runtimeSpec = readPluginAgentRuntimeSpec(agentContribution, richDefinition, entry.pluginPackageId, agentId);
      const core = richDefinition ? readJsonObjectProperty(richDefinition, 'core') : null;
      const resume = core ? readJsonObjectProperty(core, 'resume') : null;

      out.push({
        id: agentId,
        definition: readJsonSerializableValue(
          agentContribution,
          `${entry.pluginPackageId}.contributes.agents.${agentId}`,
        ),
        runtimeSpec,
        cliSubcommand: readOptionalJsonStringProperty(core ?? {}, 'cliSubcommand') ?? agentId,
        vendorResumeSupport: readOptionalJsonStringProperty(resume ?? {}, 'vendorResume') ?? 'unsupported',
        ...(commandSurfaceByAgentId.has(agentId)
          ? { commandSurface: commandSurfaceByAgentId.get(agentId) }
          : {}),
        ...(commandPolicyByAgentId.has(agentId)
          ? { commandPolicy: commandPolicyByAgentId.get(agentId) }
          : {}),
      });
      seen.add(agentId);
    }
  }

  out.sort((a, b) => compareStableProviderIdOrder(a.id, b.id));
  return out;
}

function readPluginAgentRuntimeSpec(
  agentContribution: JsonValue,
  agentDefinition: JsonObject | null,
  pluginPackageId: string,
  agentId: string,
): JsonValue {
  const cli = readJsonObjectProperty(agentDefinition ?? {}, 'cli')
    ?? readJsonObjectProperty(agentContribution, 'cli');
  if (!cli) {
    throw new Error(
      `Invalid agent contribution in ${pluginPackageId}: agent '${agentId}' must project strict native CLI/auth metadata`,
    );
  }
  const normalized = normalizeJsonSerializableValue(cli, [
    pluginPackageId,
    'contributes',
    'agents',
    agentId,
    'cli',
  ]);
  if (!isJsonObject(normalized)) throw new Error(`Invalid native CLI metadata for ${pluginPackageId}.${agentId}`);
  return projectNativeCliMetadataToRuntimeSpec(normalized, agentId);
}

function projectNativeCliMetadataToRuntimeSpec(
  cli: JsonObject,
  agentId: string,
): JsonObject {
  const executable = readJsonObjectProperty(cli, 'executable');
  const install = readJsonObjectProperty(cli, 'install');
  const manualInstall = readJsonObjectProperty(install ?? {}, 'manual');
  if (!executable || !install || !manualInstall) {
    throw new Error(`Invalid native CLI metadata for ${agentId}: executable and install metadata are required`);
  }

  const binaryName = readOptionalJsonStringProperty(executable, 'binaryName');
  const sourcePreferenceDefault = readOptionalJsonStringProperty(executable, 'sourcePreference');
  const manualInstallKind = readOptionalJsonStringProperty(manualInstall, 'kind');
  if (!binaryName || !sourcePreferenceDefault || !manualInstallKind) {
    throw new Error(`Invalid native CLI metadata for ${agentId}: executable and manual-install facts are required`);
  }

  return {
    id: agentId,
    title: readOptionalJsonStringProperty(cli, 'displayName') ?? agentId,
    binaryName,
    ...(executable.alternativeBinaryNames !== undefined
      ? { alternativeBinaryNames: executable.alternativeBinaryNames }
      : {}),
    ...(executable.alternativeBinaryFallbackEnabledEnvVar !== undefined
      ? { alternativeBinaryFallbackEnabledEnvVar: executable.alternativeBinaryFallbackEnabledEnvVar }
      : {}),
    ...(executable.knownUserBinDirSuffixes !== undefined
      ? { knownUserBinDirSuffixes: executable.knownUserBinDirSuffixes }
      : {}),
    ...(executable.systemCommandResolutionStrategy !== undefined
      ? { systemCommandResolutionStrategy: executable.systemCommandResolutionStrategy }
      : {}),
    sourcePreferenceDefault,
    managedInstall: install.managed ?? null,
    manualInstallKind,
    manualInstallRecipes: manualInstallKind === 'none'
      ? null
      : (manualInstall.recipes ?? null),
    acceptsJavaScriptFileOverride: executable.acceptsJavaScriptFileOverride ?? false,
    ...(install.recommendationOrder !== undefined
      ? { setupRecommendation: { order: install.recommendationOrder } }
      : {}),
    ...(install.guideUrl !== undefined ? { installGuideUrl: install.guideUrl } : {}),
    ...(install.docsUrl !== undefined ? { docsUrl: install.docsUrl } : {}),
  };
}

function collectBuiltInBackendContributionSources(
  dependencies: GeneratorWorkspaceDependencies,
): readonly BuiltInBackendContributionSource[] {
  const backendCatalogDefinitionsById = new Map(
    dependencies.agents.getAllBackendCatalogDefinitions()
      .map((definition) => [definition.id, definition] as const),
  );
  return dependencies.agents.getAllBackendDefinitionContracts().map((definition) => {
    const backendId = definition.id as AgentId;
    const richDefinition = backendCatalogDefinitionsById.get(backendId);
    if (!richDefinition) {
      throw new Error(`Missing built-in backend catalog definition '${definition.id}'`);
    }
    return {
      id: definition.id,
      agentId: definition.agentId,
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

async function loadPluginAgentUiBehaviorOverride(
  repoRoot: string,
  pluginPackageId: string,
  packageName: string,
  agentId: string,
): Promise<AgentUiBehaviorOverrideImportSource | undefined> {
  const behaviorPath = resolve(repoRoot, 'packages/plugins', pluginPackageId, 'src/ui/uiBehavior.ts');
  if (!existsSync(behaviorPath)) return undefined;

  const exportName = `${toAgentConstPrefix(agentId)}_UI_BEHAVIOR_OVERRIDE`;
  const source = readFileSync(behaviorPath, 'utf8');
  const exportPattern = new RegExp(`\\bexport\\s+const\\s+${exportName}\\b`);
  if (!exportPattern.test(source)) return undefined;
  return {
    importName: exportName,
    importPath: `${packageName}/ui/behavior`,
  };
}

const PLUGIN_PROMPT_ASSET_EXPORT_NAME = 'PLUGIN_PROMPT_ASSET_DESCRIPTORS';

function assertPluginPromptAssetAdapterDescriptor(value: unknown, path: string): void {
  if (!isRecord(value)) {
    throw new Error(`Invalid prompt asset adapter descriptor ${path}: expected object`);
  }
  if (value.adapterKind !== 'markdownDoc' && value.adapterKind !== 'skillMd') {
    throw new Error(`Invalid prompt asset adapter descriptor ${path}.adapterKind`);
  }
  for (const key of [
    'assetTypeId',
    'providerId',
    'title',
    'description',
    'projectRootDisplayPath',
    'userRootDisplayPath',
  ] as const) {
    if (typeof value[key] !== 'string' || value[key].trim().length === 0) {
      throw new Error(`Invalid prompt asset adapter descriptor ${path}.${key}: expected non-empty string`);
    }
  }
  for (const key of ['projectRootPath', 'userRootPath'] as const) {
    if (!Array.isArray(value[key]) || value[key].some((part) => typeof part !== 'string' || part.length === 0)) {
      throw new Error(`Invalid prompt asset adapter descriptor ${path}.${key}: expected string array`);
    }
  }
  if (value.capabilities !== undefined) {
    assertJsonSerializable(value.capabilities, [path, 'capabilities']);
  }
  if (value.skillNamePattern !== undefined && !(value.skillNamePattern instanceof RegExp)) {
    throw new Error(`Invalid prompt asset adapter descriptor ${path}.skillNamePattern: expected RegExp`);
  }
}

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
  for (const [index, contribution] of rawContributions.entries()) {
    assertPluginPromptAssetAdapterDescriptor(contribution, `${pluginPackageId}[${index}]`);
  }

  return {
    importName: `${toAgentConstPrefix(pluginPackageId)}_PROMPT_ASSET_DESCRIPTORS`,
    importPath: `${packageName}/agent/promptAssets`,
    pluginPackageId,
  };
}

function normalizePluginManifest(
  rawManifest: unknown,
  manifestPath: string,
  dependencies: GeneratorWorkspaceDependencies,
): PluginManifestJson {
  const ingestion = dependencies.protocol.ingestPluginManifestV2(rawManifest);
  if (!ingestion.ok) {
    throw new Error(`Invalid PLUGIN_MANIFEST in ${manifestPath}: ${ingestion.diagnostics.map((diagnostic) => diagnostic.message).join('; ')}`);
  }
  const manifest = ingestion.manifest;
  if (!isRecord(manifest) || typeof manifest.id !== 'string' || !manifest.id.startsWith('happier.')) {
    throw new Error(
      `Invalid PLUGIN_MANIFEST in ${manifestPath}: bundled plugins must use a canonical first-party plugin owner id under happier.*`,
    );
  }

  return manifest as PluginManifestJson;
}

function loadStaticVoicePluginManifest(
  manifestPath: string,
  dependencies: GeneratorWorkspaceDependencies,
): PluginManifestJson {
  const parserPath = fileURLToPath(new URL('./readStaticVoiceManifest.mjs', import.meta.url));
  const result = spawnSync(process.execPath, ['--max-old-space-size=256', parserPath, manifestPath], {
    encoding: 'utf8',
    killSignal: 'SIGKILL',
    maxBuffer: 256 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  });
  if (result.error) {
    throw new Error(`Failed to read static first-party voice manifest ${manifestPath}: ${result.error.message}`);
  }
  if (result.signal || result.status !== 0) {
    const detail = result.stderr.trim();
    throw new Error(detail || `Failed to read static first-party voice manifest ${manifestPath}`);
  }
  return normalizePluginManifest(JSON.parse(result.stdout), manifestPath, dependencies);
}

async function loadPluginManifest(
  repoRoot: string,
  pluginPackageId: string,
  dependencies: GeneratorWorkspaceDependencies,
): Promise<PluginManifestJson> {
  const manifestPath = resolve(repoRoot, 'packages/plugins', pluginPackageId, 'src/manifest.ts');
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing required plugin manifest for shippable plugin package ${pluginPackageId}: ${manifestPath}`);
  }

  if (
    isBundledFirstPartyVoicePackageId(pluginPackageId)
    && BUNDLED_FIRST_PARTY_VOICE_PLUGIN_IDS[pluginPackageId].startsWith('happier.voice.')
  ) {
    return loadStaticVoicePluginManifest(manifestPath, dependencies);
  }

  const mod = await importTypescriptModule(manifestPath) as { PLUGIN_MANIFEST?: unknown };
  if (!('PLUGIN_MANIFEST' in mod)) {
    throw new Error(`Expected PLUGIN_MANIFEST export in ${manifestPath}`);
  }
  return normalizePluginManifest(mod.PLUGIN_MANIFEST, manifestPath, dependencies);
}

function manifestDeclaresAgentRuntime(
  manifest: JsonValue,
  dependencies: GeneratorWorkspaceDependencies,
): boolean {
  if (!isRecord(manifest)) return false;

  const contributes = manifest.contributes;
  if (!isRecord(contributes)) return false;
  return Array.isArray(contributes.agents) && contributes.agents.some(
    (definition) => !isProviderlessReviewExecutionRunBackendContribution(
      definition as JsonValue,
      dependencies,
    ),
  );
}

function manifestDeclaresDaemonEntrypoint(manifest: JsonValue): boolean {
  const entrypoints = readJsonObjectProperty(manifest, 'entrypoints');
  return typeof entrypoints?.daemon === 'string' && entrypoints.daemon.trim().length > 0;
}

function sha256Digest(bytes: Uint8Array | string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function normalizeBundledArtifactRelativePath(packageRoot: string, path: string): string {
  const relativePath = relative(packageRoot, path).split(sep).join('/');
  if (
    !relativePath
    || relativePath === '..'
    || relativePath.startsWith('../')
    || relativePath.includes('\\')
    || relativePath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`Bundled artifact path escapes package root: ${path}`);
  }
  return relativePath;
}

function comparePortablePathCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function collectBundledArtifactFiles(
  packageRoot: string,
  packageFileEntries: readonly string[],
  installedBytesByRelativePath: ReadonlyMap<string, Uint8Array> = new Map(),
): readonly BundledImmutableArtifactFileSource[] {
  const files = new Map<string, BundledImmutableArtifactFileSource>();
  const visit = (path: string): void => {
    const relativePath = normalizeBundledArtifactRelativePath(packageRoot, path);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Bundled artifact cannot contain symbolic link '${relativePath}'`);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path, { withFileTypes: true }).sort((left, right) => (
        comparePortablePathCodeUnits(left.name, right.name)
      ))) {
        visit(resolve(path, entry.name));
      }
      return;
    }
    if (!stat.isFile()) throw new Error(`Bundled artifact contains unsupported file type '${relativePath}'`);
    // TypeScript's incremental compiler cache is not a shipped runtime input.
    // Binding it would let an otherwise byte-identical rebuild disable the
    // plugin even though every executable and declared resource stayed exact.
    if (relativePath.endsWith('.tsbuildinfo')) return;
    const bytes = installedBytesByRelativePath.get(relativePath) ?? readFileSync(path);
    files.set(relativePath, Object.freeze({
      relativePath,
      byteLength: bytes.byteLength,
      digest: sha256Digest(bytes),
    }));
  };
  for (const entry of packageFileEntries) {
    if (
      !entry
      || entry.includes('\\')
      || entry.startsWith('/')
      || entry.split('/').some((segment) => !segment || segment === '.' || segment === '..')
      || /[*?{}[\]]/u.test(entry)
    ) {
      throw new Error(`Bundled artifact package files entry must be an exact portable path: '${entry}'`);
    }
    const path = resolve(packageRoot, entry);
    if (!existsSync(path)) throw new Error(`Bundled artifact package file is missing: '${entry}'`);
    visit(path);
  }
  return Object.freeze([...files.values()].sort((left, right) => (
    comparePortablePathCodeUnits(left.relativePath, right.relativePath)
  )));
}

function normalizeDeclaredBundledPackagePath(value: string, label: string): string {
  const normalized = value.replace(/^\.\//u, '');
  if (
    !normalized
    || value.includes('\\')
    || value.startsWith('/')
    || normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`Bundled artifact ${label} must be an exact portable package path: '${value}'`);
  }
  return normalized;
}

function readBundledPackageRootExport(packageJson: Readonly<Record<string, unknown>>): string | undefined {
  if (packageJson.exports === undefined) return undefined;
  let rootExport: unknown = packageJson.exports;
  if (isRecord(rootExport) && Object.hasOwn(rootExport, '.')) rootExport = rootExport['.'];
  if (isRecord(rootExport)) rootExport = rootExport.default;
  if (typeof rootExport !== 'string') {
    throw new Error('Resource-bearing bundled package must declare one exact default package root export');
  }
  return normalizeDeclaredBundledPackagePath(rootExport, 'package root export');
}

function createBundledImmutableArtifactSource(params: Readonly<{
  packageRoot: string;
  packageJson: Readonly<Record<string, unknown>>;
  manifest: PluginManifestJson;
  dependencies: GeneratorWorkspaceDependencies;
}>): BundledImmutableArtifactSource | undefined {
  const resources = readManifestContributionArray(params.manifest, 'resources');
  if (resources.length === 0) return undefined;
  const packageFiles = params.packageJson.files;
  if (!Array.isArray(packageFiles) || packageFiles.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Resource-bearing bundled package '${params.manifest.id}' must declare an exact package.json files inventory`);
  }
  const selectedEntries = [...new Set([...packageFiles, 'package.json'])];
  const installedPackageJsonBytes = Buffer.from(
    `${JSON.stringify(
      params.dependencies.cliCommonWorkspaces.sanitizeBundledPackageJson(params.packageJson),
      null,
      2,
    )}\n`,
    'utf8',
  );
  const files = collectBundledArtifactFiles(
    params.packageRoot,
    selectedEntries,
    new Map([['package.json', installedPackageJsonBytes]]),
  );
  const mainRelativePath = typeof params.packageJson.main === 'string'
    ? normalizeDeclaredBundledPackagePath(params.packageJson.main, 'main entry')
    : undefined;
  const packageRootExport = readBundledPackageRootExport(params.packageJson);
  if (mainRelativePath && packageRootExport && mainRelativePath !== packageRootExport) {
    throw new Error(
      `Bundled package '${params.manifest.id}' package root export must match its main and daemon entry`,
    );
  }
  const packageEntryRelativePath = packageRootExport ?? mainRelativePath ?? 'dist/index.js';
  const fileByPath = new Map(files.map((file) => [file.relativePath, file]));
  const packageJsonFile = fileByPath.get('package.json');
  if (!packageJsonFile) throw new Error(`Bundled package '${params.manifest.id}' artifact omits package.json`);
  if (!fileByPath.has(packageEntryRelativePath)) {
    throw new Error(`Bundled package '${params.manifest.id}' artifact omits package root export '${packageEntryRelativePath}'`);
  }
  const declaredDaemon = readJsonObjectProperty(params.manifest, 'entrypoints')?.daemon;
  const daemonRelativePath = typeof declaredDaemon === 'string'
    ? normalizeDeclaredBundledPackagePath(declaredDaemon, 'daemon entry')
    : null;
  if (daemonRelativePath && daemonRelativePath !== packageEntryRelativePath) {
    throw new Error(
      `Bundled package '${params.manifest.id}' package root export must match its daemon entry`,
    );
  }
  const runtimeFile = daemonRelativePath ? fileByPath.get(daemonRelativePath) : undefined;
  if (daemonRelativePath && !runtimeFile) {
    throw new Error(`Bundled package '${params.manifest.id}' artifact omits daemon entry '${daemonRelativePath}'`);
  }
  for (const [index, resource] of resources.entries()) {
    if (!isJsonObject(resource) || typeof resource.path !== 'string') {
      throw new Error(`Bundled package '${params.manifest.id}' has invalid resource path at index ${String(index)}`);
    }
    const resourcePath = resource.path.replace(/^\.\//u, '');
    if (!fileByPath.has(resourcePath)) {
      throw new Error(`Bundled package '${params.manifest.id}' artifact omits resource '${resourcePath}'`);
    }
  }
  const manifestDeclarationDigest = sha256Digest(`${JSON.stringify(params.manifest)}\n`);
  const packageDigest = sha256Digest(`happier.bundled-package.v1\n${JSON.stringify(files)}\n`);
  const runtimeDigest = runtimeFile?.digest ?? sha256Digest('');
  const fingerprint = sha256Digest(`happier.bundled-generation.v1\n${params.manifest.id}\n${manifestDeclarationDigest}\n${packageDigest}\n${runtimeDigest}\n`);
  return Object.freeze({
    packageEntryRelativePath,
    record: Object.freeze({
      t: 'happier_plugin_generation_v1',
      schemaVersion: 1,
      pluginId: params.manifest.id,
      immutableGenerationId: `bundled-${fingerprint.slice('sha256:'.length)}`,
      fingerprint,
      packageDigest,
      manifestDigest: manifestDeclarationDigest,
      runtimeDigest,
      installedUiArtifactDigest: sha256Digest(''),
      createdAtMs: 0,
      files,
      installedArtifactRecord: Object.freeze({ relativePath: 'package.json', digest: packageJsonFile.digest }),
    }),
  });
}

async function readBundledPluginPackages(
  repoRoot: string,
  bundledPluginPackageNames: readonly string[],
  dependencies: GeneratorWorkspaceDependencies,
): Promise<readonly BundledPluginPackage[]> {
  const pluginsRoot = resolve(repoRoot, 'packages', 'plugins');
  if (!existsSync(pluginsRoot)) return [];

  const out: BundledPluginPackage[] = [];
  for (const packageName of bundledPluginPackageNames) {
    const pluginPackageId = pluginPackageNameToPackageId(packageName);
    const pkgJsonPath = resolve(pluginsRoot, pluginPackageId, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;
    const pkgJson = readJson(pkgJsonPath) as Record<string, unknown>;
    if (pkgJson.name !== packageName) {
      throw new Error(`Invalid plugin package name for ${pluginPackageId}: expected ${packageName}, got ${String(pkgJson.name)}`);
    }
    if (typeof pkgJson.version !== 'string' || pkgJson.version.trim().length === 0) {
      throw new Error(`Invalid plugin package version for ${pluginPackageId}: expected non-empty string`);
    }

    const manifest = await loadPluginManifest(repoRoot, pluginPackageId, dependencies);
    const immutableArtifact = createBundledImmutableArtifactSource({
      packageRoot: resolve(pluginsRoot, pluginPackageId),
      packageJson: pkgJson,
      manifest,
      dependencies,
    });
    const definitionPath = resolve(pluginsRoot, pluginPackageId, 'src/agent/definition.ts');
    const loadedAgentDefinition = existsSync(definitionPath)
      ? await loadPluginAgentDefinition(repoRoot, pluginPackageId)
      : undefined;
    const agentDefinition = loadedAgentDefinition
      ? projectNativeAgentCliDefinitionFacts(loadedAgentDefinition, manifest, pluginPackageId)
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
    const agentUiBehaviorOverride = agentUiDescriptor
      ? await loadPluginAgentUiBehaviorOverride(
        repoRoot,
        pluginPackageId,
        packageName,
        agentUiDescriptor.agentId,
      )
      : undefined;
    const promptAssetContributions = await loadPluginPromptAssetContributions(
      repoRoot,
      pluginPackageId,
      packageName,
    );
    const managedProviderImplementation = await loadManagedProviderImplementation(
      repoRoot,
      pluginPackageId,
      manifest,
    );
    const builtInLegacyConnectedAccountCompatibility =
      await loadBuiltInLegacyConnectedAccountCompatibility(
        repoRoot,
        pluginPackageId,
      );
    if (agentRuntimeContributions?.agentCatalogEntry) {
      resolvePluginRuntimeProjectionSourceFile(
        repoRoot,
        pluginPackageId,
        agentRuntimeContributions.agentCatalogEntry.source,
      );
    }
    if (!agentDefinition && manifestDeclaresAgentRuntime(manifest, dependencies)) {
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
      packageName,
      packageVersion: pkgJson.version,
      manifest,
      ...(agentDefinition ? { agentId: agentDefinition.id, agentDefinition } : {}),
      ...(agentUiDescriptor ? { agentUiDescriptor } : {}),
      ...(agentUiBehaviorOverride ? { agentUiBehaviorOverride } : {}),
      ...(agentRuntimeContributions ? { agentRuntimeContributions } : {}),
      ...(promptAssetContributions ? { promptAssetContributions } : {}),
      ...(managedProviderImplementation ? { managedProviderImplementation } : {}),
      ...(builtInLegacyConnectedAccountCompatibility
        ? { builtInLegacyConnectedAccountCompatibility }
        : {}),
      ...(immutableArtifact ? { immutableArtifact } : {}),
    });
  }

  out.sort((a, b) => a.packageName.localeCompare(b.packageName));
  return out;
}

function collectBuiltInLegacyConnectedAccountCompatibility(
  repoRoot: string,
  pluginPackages: readonly BundledPluginPackage[],
  dependencies: GeneratorWorkspaceDependencies,
): readonly BuiltInLegacyConnectedAccountCompatibilityProjection[] {
  const reservedLegacyServiceIds = [
    ...dependencies.protocol.ConnectedServiceIdSchema.options,
  ];
  const reservedLegacyServiceIdSet = new Set<string>(reservedLegacyServiceIds);
  if (reservedLegacyServiceIdSet.size !== reservedLegacyServiceIds.length) {
    throw new Error(
      'ConnectedServiceIdSchema contains duplicate reserved legacy Connected Account ids',
    );
  }
  const descriptors = pluginPackages.flatMap((pluginPackage) =>
    readManifestContributionArray(
      pluginPackage.manifest,
      'connectedAccountDescriptors',
    ).map((definition) => ({
      definition,
      pluginPackage,
      serviceLocalId: readRequiredContributionId(
        definition,
        'connectedAccountDescriptors',
        pluginPackage.pluginPackageId,
      ),
    })));
  const ownershipByLegacyServiceId =
    new Map<string, BuiltInLegacyConnectedAccountCompatibilityProjection>();

  for (const pluginPackage of pluginPackages) {
    for (
      const source
      of pluginPackage.builtInLegacyConnectedAccountCompatibility ?? []
    ) {
      if (
        !reservedLegacyServiceIdSet.has(source.legacyServiceId)
        || ownershipByLegacyServiceId.has(source.legacyServiceId)
      ) {
        throw new Error(
          `Invalid or ambiguous built-in legacy Connected Account ownership for '${source.legacyServiceId}'`,
        );
      }
      const candidates = descriptors.filter((candidate) =>
        candidate.pluginPackage === pluginPackage
        && candidate.serviceLocalId === source.serviceLocalId);
      if (candidates.length !== 1) {
        throw new Error(
          `Built-in legacy Connected Account mapping '${source.legacyServiceId}' must name one descriptor '${pluginPackage.pluginId}/${source.serviceLocalId}'`,
        );
      }
      const authentication = isRecord(candidates[0]?.definition)
        && isRecord(candidates[0].definition.authentication)
        ? candidates[0].definition.authentication
        : undefined;
      const declaredModeIds = new Set(
        Array.isArray(authentication?.modes)
          ? authentication.modes.flatMap((mode) =>
            isRecord(mode) && typeof mode.id === 'string' ? [mode.id] : [])
          : [],
      );
      const referencedModeIds = new Set([
        source.defaultAuthenticationModeId,
        ...Object.values(source.authenticationModeByCredentialKind),
      ]);
      if (
        referencedModeIds.size === 0
        || [...referencedModeIds].some((modeId) => !declaredModeIds.has(modeId))
      ) {
        throw new Error(
          `Built-in legacy Connected Account mapping '${source.legacyServiceId}' in '${pluginPackage.pluginId}' must reference only declared authentication modes`,
        );
      }
      if (
        Object.values(source.unsupportedAuthenticationModeByCredentialKind)
          .some((modeId) => declaredModeIds.has(modeId))
      ) {
        throw new Error(
          `Built-in legacy Connected Account mapping '${source.legacyServiceId}' in '${pluginPackage.pluginId}' must not expose an unsupported legacy sentinel as a declared authentication mode`,
        );
      }
      ownershipByLegacyServiceId.set(source.legacyServiceId, Object.freeze({
        legacyServiceId: source.legacyServiceId,
        service: Object.freeze({
          pluginId: pluginPackage.pluginId,
          localId: source.serviceLocalId,
        }),
        peerOperations: source.peerOperations,
        exactV0_2_1ReaderQuotaProjection:
          source.exactV0_2_1ReaderQuotaProjection,
        defaultAuthenticationModeId: source.defaultAuthenticationModeId,
        authenticationModeByCredentialKind:
          source.authenticationModeByCredentialKind,
        unsupportedAuthenticationModeByCredentialKind:
          source.unsupportedAuthenticationModeByCredentialKind,
      }));
    }
  }

  // Small generator fixtures without the Connected Services domain may omit this
  // projection. A repository with the legacy bindings or their consumed identity
  // translator must own the complete supported closed legacy set.
  const ownsLegacyConnectedServicesDomain = existsSync(resolve(
    repoRoot,
    'packages/protocol/src/connect/connectedServiceBindings.ts',
  )) || existsSync(resolve(
    repoRoot,
    'apps/server/sources/app/api/routes/connect/qualifiedConnectedAccounts/identity.ts',
  ));
  if (ownsLegacyConnectedServicesDomain) {
    for (const legacyServiceId of reservedLegacyServiceIds) {
      if (!ownershipByLegacyServiceId.has(legacyServiceId)) {
        throw new Error(
          `Missing built-in legacy Connected Account compatibility for '${legacyServiceId}'`,
        );
      }
    }
  }

  return Object.freeze(reservedLegacyServiceIds.flatMap((legacyServiceId) => {
    const ownership = ownershipByLegacyServiceId.get(legacyServiceId);
    return ownership ? [ownership] : [];
  }));
}

function renderProtocolBuiltInLegacyConnectedAccountCompatibilityTs(
  entries: readonly BuiltInLegacyConnectedAccountCompatibilityProjection[],
): string {
  const lines = [
    '/**',
    ' * GENERATED FILE. DO NOT EDIT.',
    ' *',
    ' * Built-in-only host-private compatibility for supported legacy Connected Service ids.',
    ' * Public manifests and external plugins cannot add or claim entries in this projection.',
    ' *',
    ' * Immutable released bases: server-v0.2.1 at 4913c1e533c872a0712ba1c25b3104fd470aacc2',
    ' * and cli-v0.2.1 at b1d15a8a9c241737d1ca9b167459901e6259173a.',
    ' * The prospective Remote at e67f3751f1ab5dc13e40a583a28f3962111154aa is the',
    ' * legacy GitHub credential producer consumed during Dev activation. Dev preactivation at',
    ' * 877ee97a0df346a1daaa541632dc42643d533120 produced persisted Bitbucket credentials.',
    ' * Remove this compatibility projection only after exact 0.2.1 support ends, the Remote',
    ' * predecessor no longer produces a required shape, and persisted legacy rows no longer',
    ' * require migration or reverse projection.',
    ' */',
    '',
    'export type BuiltInLegacyConnectedAccountOperation =',
    ...BUILT_IN_LEGACY_CONNECTED_ACCOUNT_OPERATION_IDS.map(
      (operation) => `  | ${JSON.stringify(operation)}`,
    ),
    ';',
    '',
    'export type BuiltInLegacyConnectedAccountCompatibility = Readonly<{',
    '  service: Readonly<{',
    '    pluginId: string;',
    '    localId: string;',
    '  }>;',
    '  peerOperations: Readonly<{',
    '    exactV0_2_1: readonly BuiltInLegacyConnectedAccountOperation[];',
    '    revisionedV2V3: readonly BuiltInLegacyConnectedAccountOperation[];',
    '  }>;',
    '  exactV0_2_1ReaderQuotaProjection: boolean;',
    '  defaultAuthenticationModeId: string;',
    '  authenticationModeByCredentialKind: Readonly<Partial<Record<"oauth" | "token", string>>>;',
    '  unsupportedAuthenticationModeByCredentialKind: Readonly<Partial<Record<"oauth" | "token", string>>>;',
    '}>;',
    '',
    'export const BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID = Object.freeze({',
  ];
  for (const entry of entries) {
    lines.push(
      `  ${JSON.stringify(entry.legacyServiceId)}: Object.freeze({`,
      '    service: Object.freeze({',
      `      pluginId: ${JSON.stringify(entry.service.pluginId)},`,
      `      localId: ${JSON.stringify(entry.service.localId)},`,
      '    }),',
      '    peerOperations: Object.freeze({',
      `      exactV0_2_1: Object.freeze(${JSON.stringify(entry.peerOperations.exactV0_2_1)} as const),`,
      `      revisionedV2V3: Object.freeze(${JSON.stringify(entry.peerOperations.revisionedV2V3)} as const),`,
      '    }),',
      `    exactV0_2_1ReaderQuotaProjection: ${JSON.stringify(entry.exactV0_2_1ReaderQuotaProjection)},`,
      `    defaultAuthenticationModeId: ${JSON.stringify(entry.defaultAuthenticationModeId)},`,
      '    authenticationModeByCredentialKind: Object.freeze({',
      ...(entry.authenticationModeByCredentialKind.oauth
        ? [`      oauth: ${JSON.stringify(entry.authenticationModeByCredentialKind.oauth)},`]
        : []),
      ...(entry.authenticationModeByCredentialKind.token
        ? [`      token: ${JSON.stringify(entry.authenticationModeByCredentialKind.token)},`]
        : []),
      '    }),',
      '    unsupportedAuthenticationModeByCredentialKind: Object.freeze({',
      ...(entry.unsupportedAuthenticationModeByCredentialKind.oauth
        ? [`      oauth: ${JSON.stringify(entry.unsupportedAuthenticationModeByCredentialKind.oauth)},`]
        : []),
      ...(entry.unsupportedAuthenticationModeByCredentialKind.token
        ? [`      token: ${JSON.stringify(entry.unsupportedAuthenticationModeByCredentialKind.token)},`]
        : []),
      '    }),',
      '  }),',
    );
  }
  lines.push(
    '} as const satisfies Readonly<Record<string, BuiltInLegacyConnectedAccountCompatibility>>);',
    '',
    'export type BuiltInLegacyConnectedServiceId =',
    '  keyof typeof BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID;',
    '',
  );
  return lines.join('\n');
}

function assertBundledVoicePackageExport(
  packageJson: Record<string, unknown>,
  packageName: string,
  exportSubpath: './ui/voice',
): void {
  const exportsMap = packageJson.exports;
  const exportTarget = isRecord(exportsMap) ? exportsMap[exportSubpath] : undefined;
  if (exportTarget === undefined) {
    throw new Error(`Missing required bundled voice export '${packageName}/${exportSubpath.slice(2)}'`);
  }
  if (!isRecord(exportTarget)) {
    throw new Error(
      `Invalid bundled voice export '${packageName}/${exportSubpath.slice(2)}': expected typed built artifact export`,
    );
  }

  const typesPath = exportTarget.types;
  const defaultPath = exportTarget.default;
  const nativePath = exportTarget['react-native'];
  const expectedConditionOrder = nativePath !== undefined
    ? ['types', 'react-native', 'default']
    : ['types', 'default'];
  if (JSON.stringify(Object.keys(exportTarget)) !== JSON.stringify(expectedConditionOrder)) {
    throw new Error(
      `Invalid bundled voice export '${packageName}/${exportSubpath.slice(2)}': expected ordered conditions ${expectedConditionOrder.join(', ')}`,
    );
  }
  const builtArtifactRoot = './dist/ui/voice/';
  const isSafeBuiltArtifactPath = (value: unknown, extension: '.d.ts' | '.js'): value is string => {
    if (typeof value !== 'string' || !value.startsWith(builtArtifactRoot) || !value.endsWith(extension)) {
      return false;
    }
    const relativePath = value.slice(builtArtifactRoot.length);
    return relativePath.length > extension.length
      && /^[A-Za-z0-9._/-]+$/.test(relativePath)
      && relativePath.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
  };
  const isBuiltTypesPath = typeof typesPath === 'string'
    && isSafeBuiltArtifactPath(typesPath, '.d.ts');
  const isBuiltRuntimePath = (value: unknown): boolean => isSafeBuiltArtifactPath(value, '.js');
  if (!isBuiltTypesPath || !isBuiltRuntimePath(defaultPath) || (nativePath !== undefined && !isBuiltRuntimePath(nativePath))) {
    throw new Error(
      `Invalid bundled voice export '${packageName}/${exportSubpath.slice(2)}': expected typed built artifact export`,
    );
  }
}

function collectBundledFirstPartyVoiceProjectionSources(
  repoRoot: string,
  pluginPackages: readonly BundledPluginPackage[],
): readonly BundledFirstPartyVoiceProjectionSource[] {
  const sources: BundledFirstPartyVoiceProjectionSource[] = [];
  const seenPluginIds = new Map<string, string>();

  for (const pluginPackage of pluginPackages) {
    const pluginPackageId = pluginPackage.pluginPackageId;
    const isReservedVoicePackage = isBundledFirstPartyVoicePackageId(pluginPackageId);
    const expectedPluginId = isReservedVoicePackage
      ? BUNDLED_FIRST_PARTY_VOICE_PLUGIN_IDS[pluginPackageId]
      : null;
    const declaresVoiceIdentity = pluginPackage.pluginId.startsWith('happier.voice.');

    if (expectedPluginId === null) {
      if (!declaresVoiceIdentity) continue;
      const reservedOwner = BUNDLED_FIRST_PARTY_VOICE_PACKAGE_IDS.find(
        (packageId) => BUNDLED_FIRST_PARTY_VOICE_PLUGIN_IDS[packageId] === pluginPackage.pluginId,
      );
      if (reservedOwner) {
        throw new Error(
          `Reserved first-party voice plugin identity '${pluginPackage.pluginId}' belongs to package '${reservedOwner}'`,
        );
      }
      throw new Error(`Unreserved first-party voice plugin identity '${pluginPackage.pluginId}'`);
    }
    if (!isBundledFirstPartyVoicePackageId(pluginPackageId)) {
      throw new Error(`Invariant violation: reserved voice package '${pluginPackageId}' was not narrowed`);
    }

    if (pluginPackage.pluginId !== expectedPluginId) {
      throw new Error(
        `Bundled first-party voice package '${pluginPackage.pluginPackageId}' must use plugin identity '${expectedPluginId}', got '${pluginPackage.pluginId}'`,
      );
    }
    const existingOwner = seenPluginIds.get(pluginPackage.pluginId);
    if (existingOwner) {
      throw new Error(
        `Duplicate bundled first-party voice plugin identity '${pluginPackage.pluginId}' from '${pluginPackage.pluginPackageId}'; already declared by '${existingOwner}'`,
      );
    }
    seenPluginIds.set(pluginPackage.pluginId, pluginPackage.pluginPackageId);

    const packageJsonPath = resolve(
      repoRoot,
      'packages',
      'plugins',
      pluginPackage.pluginPackageId,
      'package.json',
    );
    const packageJson = readJson(packageJsonPath) as Record<string, unknown>;
    assertBundledVoicePackageExport(packageJson, pluginPackage.packageName, './ui/voice');
    const conversationContributions = readManifestContributionArray(
      pluginPackage.manifest,
      'voiceProviders',
    ).filter((contribution) => isRecord(contribution) && contribution.kind === 'conversation');
    const conversationPlatforms = new Set<BundledVoiceRuntimePlatform>();
    for (const contribution of conversationContributions) {
      if (!isRecord(contribution) || !Array.isArray(contribution.platforms)) {
        throw new Error(
          `Invalid voiceProviders contribution in ${pluginPackageId}: conversation platforms are required`,
        );
      }
      for (const platform of contribution.platforms) {
        if (
          typeof platform !== 'string'
          || !BUNDLED_VOICE_RUNTIME_PLATFORMS.includes(platform as BundledVoiceRuntimePlatform)
        ) {
          throw new Error(
            `Invalid voiceProviders contribution in ${pluginPackageId}: unsupported conversation platform '${String(platform)}'`,
          );
        }
        conversationPlatforms.add(platform as BundledVoiceRuntimePlatform);
      }
    }
    sources.push({
      packageName: pluginPackage.packageName,
      packageVersion: pluginPackage.packageVersion,
      pluginId: pluginPackage.pluginId,
      pluginPackageId,
      hasConversationProvider: conversationContributions.length > 0,
      conversationPlatforms: BUNDLED_VOICE_RUNTIME_PLATFORMS.filter(
        (platform) => conversationPlatforms.has(platform),
      ),
    });
  }

  return sources.sort((a, b) => a.packageName.localeCompare(b.packageName));
}

function syncBundledVoiceUiPackageDependencies(params: Readonly<{
  rootDir: string;
  mode: Mode;
  sources: readonly BundledFirstPartyVoiceProjectionSource[];
}>): void {
  const expectedVersions = new Map(params.sources.map((source) => [source.packageName, source.packageVersion] as const));
  const reservedPackageNames = new Set(
    BUNDLED_FIRST_PARTY_VOICE_PACKAGE_IDS.map((packageId) => `@happier-dev/plugins-${packageId}`),
  );

  const packageJsonPath = resolve(params.rootDir, 'apps', 'ui', 'package.json');
  if (!existsSync(packageJsonPath)) return;
  const packageJson = readJson(packageJsonPath) as Record<string, unknown>;
  const currentDependencies = isRecord(packageJson.dependencies)
    ? packageJson.dependencies as Record<string, unknown>
    : {};
  const nextDependencies: Record<string, unknown> = {};
  for (const [name, version] of Object.entries(currentDependencies)) {
    if (!reservedPackageNames.has(name)) nextDependencies[name] = version;
  }
  for (const source of params.sources) {
    nextDependencies[source.packageName] = source.packageVersion;
  }

  const currentVoiceDependencies = Object.fromEntries(
    Object.entries(currentDependencies)
      .filter(([name]) => reservedPackageNames.has(name))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  const expectedVoiceDependencies = Object.fromEntries(
    [...expectedVersions.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
  if (params.mode === 'check') {
    if (JSON.stringify(currentVoiceDependencies) !== JSON.stringify(expectedVoiceDependencies)) {
      throw new Error('apps/ui voice plugin dependencies are out of sync');
    }
    return;
  }
  if (JSON.stringify(currentDependencies) === JSON.stringify(nextDependencies)) return;
  packageJson.dependencies = nextDependencies;
  writeFileAtomic(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
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
  lines.push('export const BUNDLED_AGENT_DEFINITIONS_BY_ID: Readonly<Record<string, BundledAgentDefinition>> = Object.freeze(_BUNDLED_AGENT_DEFINITIONS_BY_ID);');
  lines.push('');
  lines.push('// Canonical generated aggregate exports (avoid "*families*" naming).');
  lines.push('export const bundledAgentDefinitionIds = BUNDLED_AGENT_DEFINITION_IDS;');
  lines.push('export const bundledAgentDefinitions = BUNDLED_AGENT_DEFINITIONS_BY_ID;');
  lines.push('');
  return lines.join('\n');
}

function renderProtocolSessionPresentationCompatV1Ts(params: Readonly<{
  agentIds: readonly string[];
  agentDefinitionsById: Readonly<Record<string, JsonValue>>;
}>): string {
  const entries = params.agentIds.flatMap((agentId) => {
    const definition = params.agentDefinitionsById[agentId];
    if (!isRecord(definition)) return [];
    const core = readJsonObjectProperty(definition, 'core');
    if (!core) return [];
    const flavorAliases = Array.isArray(core.flavorAliases)
      ? core.flavorAliases.filter((value): value is string => typeof value === 'string')
      : [];
    const resume = readJsonObjectProperty(core, 'resume');
    const vendorResumeIdField = typeof resume?.vendorResumeIdField === 'string'
      ? resume.vendorResumeIdField
      : null;
    return [{
      agentId,
      flavorAliases: [...new Set([agentId, ...flavorAliases])],
      vendorResumeIdField,
    }];
  });

  const lines: string[] = [];
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (C8.1-session-presentation-compat)');
  lines.push(' *');
  lines.push(' * Protocol-safe projection of canonical Agent flavor aliases and vendor resume-id fields.');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`');
  lines.push(' */');
  lines.push('');
  lines.push('export const GENERATED_SESSION_PRESENTATION_COMPAT_V1 = Object.freeze([');
  for (const entry of entries) {
    lines.push('  Object.freeze({');
    lines.push(`    agentId: ${renderTsStringLiteral(entry.agentId)},`);
    lines.push(`    flavorAliases: Object.freeze(${renderTsStringArrayLiteral(entry.flavorAliases)}),`);
    lines.push(`    vendorResumeIdField: ${renderTsNullableStringLiteral(entry.vendorResumeIdField)},`);
    lines.push('  }),');
  }
  lines.push('] as const);');
  lines.push('');
  lines.push('function normalizePresentationIdentifier(value: unknown): string | null {');
  lines.push('  if (typeof value !== \'string\') return null;');
  lines.push('  const normalized = value.trim();');
  lines.push('  return normalized.length > 0 ? normalized : null;');
  lines.push('}');
  lines.push('');
  lines.push('export function resolveGeneratedSessionPresentationAgentIdV1(');
  lines.push('  metadata: Readonly<Record<string, unknown>>,');
  lines.push('): string | null {');
  lines.push('  const flavor = normalizePresentationIdentifier(metadata.flavor)?.toLowerCase() ?? null;');
  lines.push('  if (flavor) {');
  lines.push('    for (const entry of GENERATED_SESSION_PRESENTATION_COMPAT_V1) {');
  lines.push('      if (entry.flavorAliases.some((alias) => alias.trim().toLowerCase() === flavor)) {');
  lines.push('        return entry.agentId;');
  lines.push('      }');
  lines.push('    }');
  lines.push('  }');
  lines.push('  for (const entry of GENERATED_SESSION_PRESENTATION_COMPAT_V1) {');
  lines.push('    if (!entry.vendorResumeIdField) continue;');
  lines.push('    if (normalizePresentationIdentifier(metadata[entry.vendorResumeIdField])) return entry.agentId;');
  lines.push('  }');
  lines.push('  return null;');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

function renderAgentIdsTs(agentIds: readonly string[]): string {
  const lines: string[] = [];
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (A.X-agent-ids-codegen)');
  lines.push(' *');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`');
  lines.push(' *');
  lines.push(' * Agent ids are sourced from the built-in runtime catalog plus bundled plugin `AGENT_DEFINITION.id` values.');
  lines.push(' */');
  lines.push('');
  lines.push('export const AGENT_IDS = Object.freeze([');
  for (const agentId of agentIds) {
    lines.push(`  ${renderTsStringLiteral(agentId)},`);
  }
  lines.push('] as const);');
  lines.push('');
  lines.push('export type AgentId = (typeof AGENT_IDS)[number];');
  lines.push('');
  lines.push('const AGENT_ID_SET: ReadonlySet<string> = new Set(AGENT_IDS);');
  lines.push('');
  lines.push('export function isAgentId(value: unknown): value is AgentId {');
  lines.push('  return typeof value === \'string\' && AGENT_ID_SET.has(value);');
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
  lines.push(' * This protocol-owned V1 wire schema intentionally preserves the');
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

function collectGeneratedAgentIds(
  pluginAgentIds: readonly string[],
  dependencies: GeneratorWorkspaceDependencies,
): readonly string[] {
  const sourceIds = [
    ...Object.keys(dependencies.agents.CANONICAL_AGENTS_CORE),
    ...pluginAgentIds,
  ];
  const sourceIdSet = new Set(sourceIds);
  const out = STABLE_AGENT_ID_ORDER.filter((agentId) => sourceIdSet.has(agentId));
  const seen = new Set<string>(out);
  for (const agentId of pluginAgentIds) {
    if (!seen.has(agentId)) {
      seen.add(agentId);
      out.push(agentId);
    }
  }
  for (const agentId of Object.keys(dependencies.agents.CANONICAL_AGENTS_CORE)) {
    if (!seen.has(agentId)) {
      seen.add(agentId);
      out.push(agentId);
    }
  }

  return out;
}

function collectProtocolAgentProviderIdsV1(generatedAgentIds: readonly string[]): readonly string[] {
  const generatedIds = new Set(generatedAgentIds);
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
    .sort((a, b) => a.agentId.localeCompare(b.agentId));
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
    .sort((a, b) => a.agentId.localeCompare(b.agentId));
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function toScreamingSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
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

function protocolRuntimeDescriptorModuleFileName(agentId: string): string {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(agentId)) {
    throw new Error(`Invalid protocol runtime descriptor agent id '${agentId}': cannot derive generated module filename`);
  }
  return `${agentId}.ts`;
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
      assertExportedRuntimeDescriptorSymbol(
        sourceContent,
        strictCanonicalRuntimeDescriptorReaderFromReader(
          contribution.canonicalReader,
        ),
        sourceFilePath,
      );
      assertExportedRuntimeDescriptorSymbol(sourceContent, descriptorType, sourceFilePath);
      assertExportedRuntimeDescriptorSymbol(sourceContent, canonicalType, sourceFilePath);
      assertHermeticProtocolRuntimeDescriptorSource(sourceContent, sourceFilePath);
      const moduleFileName = protocolRuntimeDescriptorModuleFileName(contribution.agentId);
      return [{
        ...contribution,
        generatedImportSource: `./descriptors/${moduleFileName.replace(/\.ts$/, '')}`,
        moduleFileName,
        sourceContent,
      }];
    })
    .sort((a, b) => a.agentId.localeCompare(b.agentId));
}

function compareStableProviderIdOrder(a: string, b: string): number {
  const ai = STABLE_AGENT_ID_ORDER.indexOf(a as (typeof STABLE_AGENT_ID_ORDER)[number]);
  const bi = STABLE_AGENT_ID_ORDER.indexOf(b as (typeof STABLE_AGENT_ID_ORDER)[number]);
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
  out.sort((a, b) => compareStableProviderIdOrder(a.agentId, b.agentId));
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
  out.sort((a, b) => compareStableProviderIdOrder(a.agentId, b.agentId));
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

function readExternalSessionInstanceConstants(
  value: unknown,
  path: string,
): Readonly<Record<string, ExternalSessionInstanceConstantDescriptor>> {
  if (value === undefined) return {};
  const record = readRequiredRecord(value, path);
  const constants: Record<string, ExternalSessionInstanceConstantDescriptor> = {};
  for (const [field, constant] of Object.entries(record)) {
    if (constant !== null
      && typeof constant !== 'string'
      && typeof constant !== 'number'
      && typeof constant !== 'boolean') {
      throw new Error(`Invalid external-session source instance at ${path}.${field}: expected scalar constant`);
    }
    if (typeof constant === 'number' && !Number.isFinite(constant)) {
      throw new Error(`Invalid external-session source instance at ${path}.${field}: expected finite number`);
    }
    constants[field] = constant;
  }
  return constants;
}

function readExternalSessionInstanceDescriptor(value: unknown, path: string): ExternalSessionInstanceDescriptor {
  const record = readRequiredRecord(value, path);
  const kind = readRequiredString(record, 'kind', path);
  const constants = readExternalSessionInstanceConstants(record.constants, `${path}.constants`);
  if (kind === 'default') return { kind, constants };
  if (kind !== 'connectedServiceProfiles') {
    throw new Error(`Invalid external-session source instance at ${path}.kind: expected default or connectedServiceProfiles`);
  }
  const fields = readRequiredRecord(record.fields, `${path}.fields`);
  return {
    kind,
    serviceId: readRequiredString(record, 'serviceId', path),
    constants,
    fields: {
      serviceId: readRequiredString(fields, 'serviceId', `${path}.fields`),
      profileId: readRequiredString(fields, 'profileId', `${path}.fields`),
    },
  };
}

function readExternalSessionSourceDeclaration(
  value: JsonValue,
  path: string,
  agentId: string,
): ExternalSessionSourceDeclaration {
  const record = readRequiredRecord(value, path);
  if (Object.prototype.hasOwnProperty.call(record, 'agentId') || Object.prototype.hasOwnProperty.call(record, 'providerId')) {
    throw new Error(
      `Invalid external-session source declaration at ${path}.agentId: agentId is derived from manifest.contributes.agents[].id`,
    );
  }
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
  const instances = record.instances;
  if (instances !== undefined && (!Array.isArray(instances) || instances.length === 0)) {
    throw new Error(`Invalid external-session source declaration at ${path}.instances: expected non-empty array`);
  }
  return {
    agentId,
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
    ...(instances === undefined
      ? {}
      : {
        instances: instances.map((instance, index) => readExternalSessionInstanceDescriptor(
          instance,
          `${path}.instances[${String(index)}]`,
        )),
      }),
  };
}

async function collectProtocolExternalSessionSourceContributions(
  pluginPackages: readonly BundledPluginPackage[],
): Promise<readonly ProtocolExternalSessionSourceProjectionDescriptor[]> {
  const out: ProtocolExternalSessionSourceProjectionDescriptor[] = [];
  for (const entry of pluginPackages) {
    const backendContributions = readManifestContributionArray(entry.manifest, 'agents');
    for (const backendContribution of backendContributions) {
      const providerId = readRequiredContributionId(
        backendContribution,
        'agents',
        entry.pluginPackageId,
      );
      // A bundled package may use a manifest-safe local id that differs only
      // in casing from the canonical host Agent id (currently Oh My Pi). The
      // protocol source union is consumed by host runtime contracts, so its
      // discriminator owner must be the canonical Agent definition id.
      const canonicalAgentId = entry.agentId ?? providerId;
      const surfaces = readJsonObjectProperty(backendContribution, 'surfaces');
      const externalSession = readJsonObjectProperty(surfaces, 'externalSession');
      const sources = externalSession === null ? [] : externalSession.sources;
      if (sources === undefined) continue;
      if (!Array.isArray(sources)) {
        throw new Error(
          `Invalid external-session source declaration in ${entry.pluginPackageId}.${providerId}.surfaces.externalSession.sources: expected array`,
        );
      }
      for (const [index, rawDeclaration] of sources.entries()) {
        const declaration = readExternalSessionSourceDeclaration(
          rawDeclaration,
          `${entry.pluginPackageId}.${providerId}.surfaces.externalSession.sources[${String(index)}]`,
          canonicalAgentId,
        );
        out.push({
          agentId: canonicalAgentId,
          declaration,
        });
      }
    }
  }
  out.sort((a, b) => {
    const agentOrder = compareStableProviderIdOrder(a.agentId, b.agentId);
    if (agentOrder !== 0) return agentOrder;
    return a.declaration.sourceKind.localeCompare(b.declaration.sourceKind);
  });
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
  providerMigrationSourceProfileIds: readonly string[],
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
  lines.push(`export const GENERATED_PROVIDER_MIGRATION_SOURCE_PROFILE_IDS = ${renderTsStringArrayLiteral(providerMigrationSourceProfileIds)} as const;`);
  lines.push('');
  return lines.join('\n');
}

function collectProviderMigrationSourceProfileIds(
  pluginPackages: readonly BundledPluginPackage[],
): readonly string[] {
  const ids = new Set<string>();
  for (const entry of pluginPackages) {
    for (const provider of readManifestContributionArray(entry.manifest, 'providers')) {
      const migrations = isJsonObject(provider) ? provider.legacyProfileMigrations : undefined;
      if (migrations === undefined) continue;
      if (!Array.isArray(migrations)) {
        throw new Error(`${entry.pluginPackageId}.contributes.providers legacyProfileMigrations must be an array`);
      }
      for (const migration of migrations) {
        if (!isJsonObject(migration) || typeof migration.sourceProfileId !== 'string' || migration.sourceProfileId.trim().length === 0) {
          throw new Error(`${entry.pluginPackageId}.contributes.providers legacy migration must declare sourceProfileId`);
        }
        ids.add(migration.sourceProfileId);
      }
    }
  }
  return [...ids].sort();
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
  if (executableContributions.length > 0) {
    lines.push('import {');
    lines.push('  createGeneratedRuntimeProjectionSessionControlAdapter,');
    lines.push('  type GeneratedRuntimeProjectionSessionControlAdapterConfig,');
    lines.push('} from \'../runtime/identity/generatedRuntimeProjection.js\';');
  }
  if (dataOnlyContributions.length > 0) {
    lines.push('import {');
    lines.push('  createRuntimeDescriptorResumeIdSessionControlAdapter,');
    lines.push('} from \'../runtime/controlSurface/runtimeDescriptorResume.js\';');
  }
  lines.push('import type { ProviderSessionControlAdapter } from \'../runtime/controlSurface/types.js\';');
  lines.push('');
  for (const contribution of executableContributions) {
    const constName = `${toScreamingSnakeCase(contribution.agentId)}_GENERATED_SESSION_CONTROL_ADAPTER`;
    lines.push(`const ${constName} = createGeneratedRuntimeProjectionSessionControlAdapter(`);
    lines.push(`${renderJsonLiteral(contribution.generatedAdapter, 2)} satisfies GeneratedRuntimeProjectionSessionControlAdapterConfig<${renderTsStringLiteral(contribution.agentId)}>,`);
    lines.push(');');
    lines.push('');
  }
  lines.push('export const GENERATED_PROVIDER_SESSION_CONTROL_ADAPTER_PROVIDER_IDS = [');
  for (const contribution of contributions) {
    lines.push(`  ${renderTsStringLiteral(contribution.agentId)},`);
  }
  lines.push('] as const;');
  lines.push('');
  lines.push('export type GeneratedProviderSessionControlAdapterProviderId =');
  lines.push('  (typeof GENERATED_PROVIDER_SESSION_CONTROL_ADAPTER_PROVIDER_IDS)[number];');
  lines.push('');
  lines.push('export const GENERATED_PROVIDER_SESSION_CONTROL_ADAPTERS: Readonly<Record<GeneratedProviderSessionControlAdapterProviderId, ProviderSessionControlAdapter>> = Object.freeze({');
  for (const contribution of contributions) {
    if (contribution.kind === 'providerSessionControlAdapter') {
      lines.push(`  ${contribution.agentId}: ${toScreamingSnakeCase(contribution.agentId)}_GENERATED_SESSION_CONTROL_ADAPTER,`);
    } else {
      lines.push(`  ${contribution.agentId}: createRuntimeDescriptorResumeIdSessionControlAdapter({`);
      lines.push(`    providerId: ${renderTsStringLiteral(contribution.agentId)},`);
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
  if (executableContributions.length > 0) {
    lines.push('import {');
    lines.push('  createGeneratedRuntimeDescriptorReader,');
    lines.push('  type GeneratedRuntimeDescriptorReaderConfig,');
    lines.push('} from \'../runtime/identity/generatedRuntimeProjection.js\';');
  }
  if (dataOnlyContributions.length > 0) {
    lines.push('import {');
    lines.push('  createProviderSessionIdRuntimeDescriptorReader,');
    lines.push('} from \'../runtime/identity/providerSessionIdReader.js\';');
  }
  lines.push('import type { RuntimeDescriptorReaderMap } from \'../runtime/identity/runtimeDescriptorTypes.js\';');
  lines.push('');
  for (const contribution of executableContributions) {
    const constName = `${toScreamingSnakeCase(contribution.agentId)}_GENERATED_RUNTIME_DESCRIPTOR_READER`;
    lines.push(`const ${constName} = createGeneratedRuntimeDescriptorReader(`);
    lines.push(`${renderJsonLiteral(contribution.generatedReader, 2)} satisfies GeneratedRuntimeDescriptorReaderConfig<${renderTsStringLiteral(contribution.agentId)}>,`);
    lines.push(');');
    lines.push('');
  }
  lines.push('export const GENERATED_RUNTIME_DESCRIPTOR_READER_PROVIDER_IDS = [');
  for (const contribution of contributions) {
    lines.push(`  ${renderTsStringLiteral(contribution.agentId)},`);
  }
  lines.push('] as const;');
  lines.push('');
  lines.push('export type GeneratedRuntimeDescriptorReaderProviderId =');
  lines.push('  (typeof GENERATED_RUNTIME_DESCRIPTOR_READER_PROVIDER_IDS)[number];');
  lines.push('');
  lines.push('export const GENERATED_RUNTIME_DESCRIPTOR_READERS: Readonly<Pick<RuntimeDescriptorReaderMap, GeneratedRuntimeDescriptorReaderProviderId>> = Object.freeze({');
  for (const contribution of contributions) {
    if (contribution.kind === 'providerRuntimeDescriptorReader') {
      lines.push(`  ${contribution.agentId}: ${toScreamingSnakeCase(contribution.agentId)}_GENERATED_RUNTIME_DESCRIPTOR_READER,`);
    } else {
      lines.push(`  ${contribution.agentId}: createProviderSessionIdRuntimeDescriptorReader({`);
      lines.push(`    providerId: ${renderTsStringLiteral(contribution.agentId)},`);
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

function strictCanonicalRuntimeDescriptorReaderFromReader(
  canonicalReader: string,
): string {
  if (!canonicalReader.startsWith('readCanonical')) {
    throw new Error(`Invalid canonical runtime descriptor reader '${canonicalReader}': expected readCanonical*`);
  }
  return canonicalReader.replace(/^readCanonical/, 'readStrictCanonical');
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
    const strictCanonicalReader =
      strictCanonicalRuntimeDescriptorReaderFromReader(contribution.canonicalReader);
    lines.push('import {');
    lines.push(`  ${contribution.buildFunction},`);
    lines.push(`  ${contribution.canonicalReader},`);
    lines.push(`  ${strictCanonicalReader},`);
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
    lines.push(`  ${renderTsStringLiteral(contribution.agentId)},`);
  }
  lines.push('] as const;');
  lines.push('');
  lines.push('export type GeneratedRuntimeDescriptorProviderIdV1 =');
  lines.push('  (typeof GENERATED_RUNTIME_DESCRIPTOR_PROVIDER_IDS_V1)[number];');
  lines.push('');
  lines.push('export type GeneratedRuntimeDescriptorByProviderIdV1 = {');
  for (const contribution of contributions) {
    lines.push(`  ${contribution.agentId}: ${runtimeDescriptorTypeFromBuildFunction(contribution.buildFunction)};`);
  }
  lines.push('};');
  lines.push('');
  lines.push('export type GeneratedCanonicalRuntimeDescriptorByProviderIdV1 = {');
  for (const contribution of contributions) {
    lines.push(`  ${contribution.agentId}: ${canonicalRuntimeDescriptorTypeFromReader(contribution.canonicalReader)};`);
  }
  lines.push('};');
  lines.push('');
  lines.push('type GeneratedRuntimeDescriptorContributionV1 = Readonly<{');
  lines.push('  agentId: GeneratedRuntimeDescriptorProviderIdV1;');
  lines.push('  readCanonicalDescriptor: (descriptor: unknown) => unknown;');
  lines.push('  readStrictCanonicalDescriptor: (descriptor: unknown) => unknown;');
  lines.push('}>;');
  lines.push('');
  lines.push('export const GENERATED_RUNTIME_DESCRIPTOR_CONTRIBUTIONS_V1 = Object.freeze({');
  for (const contribution of contributions) {
    const descriptorType = runtimeDescriptorTypeFromBuildFunction(contribution.buildFunction);
    const strictCanonicalReader =
      strictCanonicalRuntimeDescriptorReaderFromReader(contribution.canonicalReader);
    lines.push(`  ${contribution.agentId}: Object.freeze({`);
    lines.push(`    agentId: ${renderTsStringLiteral(contribution.agentId)},`);
    lines.push(`    readCanonicalDescriptor: (descriptor: unknown) => ${contribution.canonicalReader}(`);
    lines.push(`      descriptor as ${descriptorType} | null,`);
    lines.push('    ),');
    lines.push(`    readStrictCanonicalDescriptor: (descriptor: unknown) => ${strictCanonicalReader}(`);
    lines.push(`      descriptor as ${descriptorType} | null,`);
    lines.push('    ),');
    lines.push('  }),');
  }
  lines.push('} satisfies {');
  lines.push('  readonly [K in GeneratedRuntimeDescriptorProviderIdV1]: GeneratedRuntimeDescriptorContributionV1;');
  lines.push('});');
  lines.push('');
  lines.push('export function getGeneratedRuntimeDescriptorContributionV1<TProviderId extends GeneratedRuntimeDescriptorProviderIdV1>(');
  lines.push('  agentId: TProviderId,');
  lines.push('): GeneratedRuntimeDescriptorContributionV1;');
  lines.push('export function getGeneratedRuntimeDescriptorContributionV1(');
  lines.push('  agentId: string,');
  lines.push('): GeneratedRuntimeDescriptorContributionV1 | null;');
  lines.push('export function getGeneratedRuntimeDescriptorContributionV1(');
  lines.push('  agentId: string,');
  lines.push('): GeneratedRuntimeDescriptorContributionV1 | null {');
  lines.push('  return Object.hasOwn(GENERATED_RUNTIME_DESCRIPTOR_CONTRIBUTIONS_V1, agentId)');
  lines.push('    ? GENERATED_RUNTIME_DESCRIPTOR_CONTRIBUTIONS_V1[agentId as GeneratedRuntimeDescriptorProviderIdV1]');
  lines.push('    : null;');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

function renderCliBundledPluginEntriesTs(params: Readonly<{
  pluginPackages: readonly BundledPluginPackage[];
}>): string {
  const implementationSources = collectProviderCatalogEntryHookSources(params.pluginPackages);
  const pluginByAgentId = new Map(
    params.pluginPackages.flatMap((entry) => entry.agentId ? [[entry.agentId, entry] as const] : []),
  );
  const metadata = params.pluginPackages.map((entry) => ({
    ...(entry.agentId ? { agentId: entry.agentId } : {}),
    manifestDigest: entry.immutableArtifact?.record.manifestDigest
      ?? `bundled:${entry.packageName}@${entry.packageVersion}`,
    manifestPath: `bundled:${entry.pluginId}`,
    packageName: entry.packageName,
    packageVersion: entry.packageVersion,
    pluginId: entry.pluginId,
    pluginPackageId: entry.pluginPackageId,
  }));

  const lines: string[] = [];
  lines.push('/* eslint-disable @typescript-eslint/naming-convention */');
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (WS1.T3)');
  lines.push(' *');
  lines.push(' * Locator/provenance records and trusted implementation bindings only.');
  lines.push(' * Contribution declarations are ingested from each PLUGIN_MANIFEST by the');
  lines.push(' * same canonical path used for installed plugins.');
  lines.push(' */');
  lines.push('');
  lines.push("import { createPluginContributionIdentity } from '@happier-dev/protocol';");
  lines.push("import type { PluginContributionIdentityV1, PluginSourceSpecV1 } from '@happier-dev/protocol';");
  for (const pluginPackage of params.pluginPackages) {
    lines.push(`import { PLUGIN_MANIFEST as ${toAgentConstPrefix(pluginPackage.pluginPackageId)}_PLUGIN_MANIFEST } from ${renderTsStringLiteral(`${pluginPackage.packageName}/manifest`)};`);
  }
  for (const pluginPackage of params.pluginPackages) {
    const managed = pluginPackage.managedProviderImplementation;
    if (!managed) continue;
    lines.push(
      `import { ${managed.runtimeAdapterExportName} as ${toAgentConstPrefix(pluginPackage.pluginPackageId)}_MANAGED_PROVIDER_RUNTIME_ADAPTER } from ${renderTsStringLiteral(pluginPackage.packageName)};`,
    );
  }
  if (implementationSources.length > 0) {
    lines.push("import { createAgentRuntimeCatalogEntryHooks } from '../agentCatalogEntryHooks';");
  }
  for (const source of implementationSources) {
    lines.push(`import { ${source.importName} } from ${renderTsStringLiteral(source.importPath)};`);
  }
  const externalSessionHostAdapterImportSources = implementationSources.flatMap((source) => [
    source.externalSessionHostAdapters?.candidateHostAdapter,
    source.externalSessionHostAdapters?.transcriptStoreAdapter,
  ].filter((entry): entry is ExternalSessionHostAdapterImportSource => Boolean(entry)));
  for (const source of externalSessionHostAdapterImportSources) {
    lines.push(`import { ${source.exportName} as ${source.importAlias} } from ${renderTsStringLiteral(source.importPath)};`);
  }
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
  lines.push('export type BundledFirstPartyPluginLocator = Readonly<{');
  lines.push('  pluginId: string;');
  lines.push('  manifest: unknown;');
  lines.push('  manifestPath: string;');
  lines.push('  manifestDigest: string;');
  lines.push('  daemonEntryPath: string | null;');
  lines.push('  devDaemonEntryPath?: string | null;');
  lines.push('  sourceSpec: PluginSourceSpecV1;');
  lines.push('}>;');
  lines.push('');
  lines.push('export type BundledFirstPartyImplementationBinding = Readonly<{');
  lines.push('  identity: PluginContributionIdentityV1;');
  lines.push('  implementationOwnerId: string;');
  lines.push('  registrationFamily: string;');
  lines.push('  implementation: unknown;');
  lines.push('  runtimeAdapter?: unknown;');
  lines.push('}>;');
  lines.push('');
  lines.push('export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES: readonly string[] = Object.freeze([');
  for (const entry of params.pluginPackages) lines.push(`  ${JSON.stringify(entry.packageName)},`);
  lines.push(']);');
  lines.push('');
  lines.push('export const BUNDLED_FIRST_PARTY_PLUGIN_METADATA: readonly BundledFirstPartyPluginMetadata[] = Object.freeze(');
  lines.push(`${renderJsonLiteral(metadata)});`);
  lines.push('');
  lines.push('export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS: readonly BundledFirstPartyPluginLocator[] = Object.freeze([');
  for (const entry of params.pluginPackages) {
    const prefix = toAgentConstPrefix(entry.pluginPackageId);
    const manifestDigest = entry.immutableArtifact?.record.manifestDigest
      ?? `bundled:${entry.packageName}@${entry.packageVersion}`;
    const resolvedDigest = entry.immutableArtifact?.record.packageDigest
      ?? `bundled:${entry.packageName}@${entry.packageVersion}`;
    lines.push('  Object.freeze({');
    lines.push(`    pluginId: ${JSON.stringify(entry.pluginId)},`);
    lines.push(`    manifest: ${prefix}_PLUGIN_MANIFEST,`);
    lines.push(`    manifestPath: ${JSON.stringify(`bundled:${entry.pluginId}`)},`);
    lines.push(`    manifestDigest: ${JSON.stringify(manifestDigest)},`);
    lines.push(`    daemonEntryPath: ${manifestDeclaresDaemonEntrypoint(entry.manifest) ? JSON.stringify(entry.packageName) : 'null'},`);
    lines.push('    sourceSpec: Object.freeze({');
    lines.push("      kind: 'bundled',");
    lines.push(`      locator: ${JSON.stringify(entry.packageName)},`);
    lines.push("      trustPolicy: 'local_trusted',");
    lines.push("      installPolicy: 'link',");
    lines.push(`      resolvedVersion: ${JSON.stringify(entry.packageVersion)},`);
    lines.push(`      resolvedDigest: ${JSON.stringify(resolvedDigest)},`);
    lines.push('    }),');
    lines.push('  }),');
  }
  lines.push(']);');
  lines.push('');
  lines.push('export const BUNDLED_FIRST_PARTY_IMPLEMENTATION_BINDINGS: readonly BundledFirstPartyImplementationBinding[] = Object.freeze([');
  for (const source of implementationSources) {
    const pluginPackage = pluginByAgentId.get(source.agentId);
    if (!pluginPackage) throw new Error(`Missing bundled plugin locator for agent implementation '${source.agentId}'`);
    lines.push('  Object.freeze({');
    lines.push('    identity: createPluginContributionIdentity({');
    lines.push(`      pluginId: ${JSON.stringify(pluginPackage.pluginId)},`);
    const manifestAgent = readManifestContributionArray(pluginPackage.manifest, 'agents')[0];
    const manifestAgentId = readRequiredContributionId(manifestAgent, 'agents', pluginPackage.pluginPackageId);
    lines.push(`      localId: ${JSON.stringify(manifestAgentId)},`);
    lines.push('    }),');
    lines.push(`    implementationOwnerId: ${JSON.stringify(source.agentId)},`);
    lines.push("    registrationFamily: 'agents',");
    lines.push('    implementation: createAgentRuntimeCatalogEntryHooks({');
    lines.push(`      agentId: ${renderTsStringLiteral(source.agentId)},`);
    lines.push(`      packageName: ${renderTsStringLiteral(source.packageName)},`);
    if (source.externalSessionHostAdapters) {
      lines.push('      contribution: {');
      lines.push(`        ...${source.importName},`);
      lines.push('        externalSessions: {');
      if (source.externalSessionHostAdapters.candidateHostAdapter) {
        lines.push(`          createCandidateHostAdapter: ${source.externalSessionHostAdapters.candidateHostAdapter.importAlias},`);
      }
      if (source.externalSessionHostAdapters.transcriptStoreAdapter) {
        lines.push(`          createTranscriptStoreAdapter: ${source.externalSessionHostAdapters.transcriptStoreAdapter.importAlias},`);
      }
      lines.push('        },');
      lines.push('      },');
    } else {
      lines.push(`      contribution: ${source.importName},`);
    }
    if (source.systemTools.length > 0) {
      const manifestPrefix = toAgentConstPrefix(pluginPackage.pluginPackageId);
      lines.push(`      systemTools: ${manifestPrefix}_PLUGIN_MANIFEST.contributes.systemTools,`);
    }
    lines.push('    }),');
    lines.push('  }),');
  }
  for (const pluginPackage of params.pluginPackages) {
    const managed = pluginPackage.managedProviderImplementation;
    if (!managed) continue;
    const implementationOwnerId = `${pluginPackage.pluginId}/${managed.providerLocalId}`;
    lines.push('  Object.freeze({');
    lines.push('    identity: createPluginContributionIdentity({');
    lines.push(`      pluginId: ${JSON.stringify(pluginPackage.pluginId)},`);
    lines.push(`      localId: ${JSON.stringify(managed.providerLocalId)},`);
    lines.push('    }),');
    lines.push(`    implementationOwnerId: ${JSON.stringify(implementationOwnerId)},`);
    lines.push("    registrationFamily: 'providers',");
    lines.push(`    implementation: Object.freeze(${renderJsonLiteral(managed.facet)}),`);
    lines.push(`    runtimeAdapter: ${toAgentConstPrefix(pluginPackage.pluginPackageId)}_MANAGED_PROVIDER_RUNTIME_ADAPTER,`);
    lines.push('  }),');
  }
  lines.push(']);');
  lines.push('');
  return lines.join('\n');
}

function renderCliBundledPluginArtifactsTs(pluginPackages: readonly BundledPluginPackage[]): string {
  const artifacts = pluginPackages.flatMap((entry) => entry.immutableArtifact
    ? [{
      packageName: entry.packageName,
      packageEntryRelativePath: entry.immutableArtifact.packageEntryRelativePath,
      record: entry.immutableArtifact.record,
    }]
    : []);
  return [
    '/** GENERATED FILE CONTRACT (WS4.T2/SVC11 bundled immutable artifacts). */',
    "import type { BundledImmutablePluginArtifact } from '../../../store/registry/generationStore';",
    '',
    'export const BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS = Object.freeze(',
    `${renderJsonLiteral(artifacts as unknown as JsonValue)} satisfies readonly BundledImmutablePluginArtifact[]);`,
    '',
  ].join('\n');
}

async function writeBundledImmutableArtifactEntriesUnlocked(
  rootDir: string,
  dependencies: GeneratorWorkspaceDependencies,
): Promise<void> {
  const packageNames = readBundledPluginPackageNames(rootDir).filter((packageName) => (
    existsSync(resolve(rootDir, 'packages/plugins', pluginPackageNameToPackageId(packageName), 'resources'))
  ));
  const pluginPackages = await readBundledPluginPackages(rootDir, packageNames, dependencies);
  const outPath = resolve(rootDir, 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPluginArtifacts.ts');
  writeFileAtomic(outPath, renderCliBundledPluginArtifactsTs(pluginPackages));
}

export async function writeBundledImmutableArtifactEntries(rootDir: string): Promise<void> {
  await withGeneratorWorkspaceLock(
    rootDir,
    async (dependencies) => await writeBundledImmutableArtifactEntriesUnlocked(rootDir, dependencies),
  );
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

function renderAgentLogoSvgXmlExpression(svgIconKey: string | null): string {
  if (!svgIconKey) return 'null';
  if (/^[A-Za-z_$][\w$]*$/.test(svgIconKey)) {
    return `AGENT_LOGO_SVG_XML.${svgIconKey} ?? null`;
  }
  return `AGENT_LOGO_SVG_XML[${renderTsStringLiteral(svgIconKey)}] ?? null`;
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

function readProviderOwnedEnvironmentKeys(
  pluginPackage: BundledPluginPackage,
  agentId: string,
): readonly string[] {
  const contribution = readManifestContributionArray(pluginPackage.manifest, 'agents')
    .find((entry) => readRequiredContributionId(entry, 'agents', pluginPackage.packageName) === agentId);
  if (!contribution) return [];
  const providerRequirements = readJsonObjectProperty(contribution, 'providerRequirements');
  const authIsolation = providerRequirements ? readJsonObjectProperty(providerRequirements, 'authIsolation') : undefined;
  const raw = authIsolation?.ownedEnvKeys;
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((value) => typeof value !== 'string')) {
    throw new Error(`${pluginPackage.packageName}.contributes.agents.${agentId}.providerRequirements.authIsolation.ownedEnvKeys must be a string array`);
  }
  return raw;
}

function createDescriptorAgentUiProjectionSource(
  pluginPackage: BundledPluginPackage,
  descriptor: AgentUiDescriptor,
): DescriptorAgentUiProjectionSource {
  const constPrefix = toAgentConstPrefix(descriptor.agentId);
  const svgIcon = readDescriptorGeneratedSvgIcon(descriptor, constPrefix);
  return {
    agentId: descriptor.agentId,
    coreConst: `${constPrefix}_CORE`,
    uiConst: `${constPrefix}_UI`,
    descriptor,
    providerOwnedEnvironmentKeys: readProviderOwnedEnvironmentKeys(pluginPackage, descriptor.agentId),
    ...(svgIcon === undefined ? {} : { svgIcon }),
  };
}

function collectAgentUiBehaviorOverrideSources(pluginPackages: readonly BundledPluginPackage[]): readonly AgentUiBehaviorOverrideSource[] {
  return pluginPackages.flatMap((pluginPackage): AgentUiBehaviorOverrideSource[] => {
    const behavior = pluginPackage.agentUiDescriptor?.behavior;
    const components = pluginPackage.agentUiDescriptor?.components;
    const message = pluginPackage.agentUiDescriptor?.message;
    const projection = {
      ...(hasDescriptorFields(behavior) ? behavior : {}),
      ...(hasDescriptorFields(message) ? { message } : {}),
      ...(hasDescriptorFields(components) ? { components } : {}),
    };
    if (
      !hasDescriptorFields(projection)
      && !pluginPackage.agentUiBehaviorOverride
    ) {
      return [];
    }
    if (!pluginPackage.agentUiDescriptor?.agentId) return [];
    return [{
      agentId: pluginPackage.agentUiDescriptor.agentId,
      descriptor: projection,
      ...(pluginPackage.agentUiBehaviorOverride
        ? { behaviorOverride: pluginPackage.agentUiBehaviorOverride }
        : {}),
    }];
  });
}

function collectAgentSessionBehaviorSources(
  pluginPackages: readonly BundledPluginPackage[],
): readonly AgentSessionBehaviorSource[] {
  return pluginPackages.flatMap((pluginPackage): AgentSessionBehaviorSource[] => {
    const projection = pluginPackage.agentUiDescriptor?.session;
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
): readonly AgentCatalogEntryHookSource[] {
  return pluginPackages.flatMap((pluginPackage): AgentCatalogEntryHookSource[] => {
    const projection = pluginPackage.agentRuntimeContributions?.agentCatalogEntry;
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
  const svgIconXmlExpression = source.svgIcon?.constName ?? renderAgentLogoSvgXmlExpression(readUiDescriptorSvgIconKey(descriptor));
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
    `    uiConnectedService: { serviceId: ${renderTsNullableStringLiteral(descriptor.display.connectedService.serviceId)}, labelKey: ${renderTsStringLiteral(descriptor.display.connectedService.labelKey)}, connectRoute: ${renderTsNullableStringLiteral(descriptor.display.connectedService.connectRoute)} },`,
  );
  lines.push(`    flavorAliases: ${renderTsStringArrayLiteral(descriptor.display.flavorAliases)},`);
  lines.push(`    providerOwnedEnvironmentKeys: ${renderTsStringArrayLiteral(source.providerOwnedEnvironmentKeys)},`);
  lines.push(`    cli: buildCatalogAgentCliUiConfig(${agentId}),`);
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
  lines.push(`    cliGlyph: ${renderTsStringLiteral(descriptor.display.picker.cliGlyph)},`);
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
    '    uiConnectedService: { serviceId: null, labelKey: \'agentInput.agent.qwen\', connectRoute: null },',
    '    flavorAliases: [\'qwen\', \'qwen-code\'],',
    '    cli: buildCatalogAgentCliUiConfig(\'qwen\'),',
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
    '    svgIconXml: AGENT_LOGO_SVG_XML.qwen ?? null,',
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

function renderUiBundledPluginEntriesTs(params: Readonly<{
  packageNames: readonly string[];
  pluginPackages: readonly BundledPluginPackage[];
}>): string {
  const generatedSourcesByAgentId = new Map(
    GENERATED_AGENT_UI_PROJECTION_SOURCES.map((source) => [source.agentId, source] as const),
  );
  const descriptorSourcesByAgentId = new Map(
    params.pluginPackages
      .flatMap((entry) => (entry.agentUiDescriptor ? [createDescriptorAgentUiProjectionSource(entry, entry.agentUiDescriptor)] : []))
      .map((source) => [source.agentId, source] as const),
  );
  const uiProjectionOrder = new Set(AGENT_UI_PROJECTION_ORDER);
  for (const agentId of descriptorSourcesByAgentId.keys()) {
    if (!uiProjectionOrder.has(agentId)) {
      throw new Error(`Bundled agent UI descriptor '${agentId}' is missing from AGENT_UI_PROJECTION_ORDER`);
    }
  }
  const bundledAgentIds = new Set(
    params.pluginPackages.flatMap((entry) => (entry.agentId ? [entry.agentId] : [])),
  );
  const pluginPackageByAgentId = new Map(
    params.pluginPackages.flatMap((entry) => entry.agentId ? [[entry.agentId, entry] as const] : []),
  );
  const selectedProjectionSources = AGENT_UI_PROJECTION_ORDER.flatMap((agentId) => {
    const descriptorSource = descriptorSourcesByAgentId.get(agentId);
    const generatedSource = generatedSourcesByAgentId.get(agentId);
    if (!descriptorSource && !generatedSource) return [];
    let projectionLines = descriptorSource
      ? renderDescriptorGeneratedUiProjectionLines(descriptorSource)
      : generatedSource?.renderLines() ?? [];
    if (!descriptorSource && generatedSource) {
      const pluginPackage = pluginPackageByAgentId.get(agentId);
      const providerOwnedEnvironmentKeys = pluginPackage
        ? readProviderOwnedEnvironmentKeys(pluginPackage, agentId)
        : [];
      const insertionIndex = projectionLines.findIndex((line) => line.trimStart().startsWith('flavorAliases:'));
      if (insertionIndex < 0) throw new Error(`Generated UI projection '${agentId}' has no flavorAliases insertion anchor`);
      projectionLines = [
        ...projectionLines.slice(0, insertionIndex + 1),
        `    providerOwnedEnvironmentKeys: ${renderTsStringArrayLiteral(providerOwnedEnvironmentKeys)},`,
        ...projectionLines.slice(insertionIndex + 1),
      ];
    }
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
  lines.push('import { AGENT_LOGO_SVG_XML } from \'./agentLogoSvgXml\';');
  lines.push('');
  lines.push('import { buildCatalogAgentCliUiConfig } from \'@/agents/registry/buildCatalogAgentCliUiConfig\';');
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
  lines.push('export const BUNDLED_CANONICAL_AGENT_CONTRIBUTION_IDENTITIES: Readonly<Record<');
  lines.push('  CanonicalAgentId,');
  lines.push('  Readonly<{ pluginId: string; localId: string }>');
  lines.push('>> = Object.freeze({');
  for (const agentId of AGENT_UI_PROJECTION_ORDER) {
    const pluginPackage = pluginPackageByAgentId.get(agentId);
    if (!pluginPackage) {
      if (!bundledAgentIds.has(agentId)) continue;
      throw new Error(`Missing bundled plugin package for Agent identity '${agentId}'`);
    }
    const manifestAgent = readManifestContributionArray(pluginPackage.manifest, 'agents')[0];
    const localId = readRequiredContributionId(manifestAgent, 'agents', pluginPackage.pluginPackageId);
    lines.push(`    ${agentId}: Object.freeze({`);
    lines.push(`        pluginId: ${JSON.stringify(pluginPackage.pluginId)},`);
    lines.push(`        localId: ${JSON.stringify(localId)},`);
    lines.push('    }),');
  }
  lines.push('});');
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
  const behaviorOverrideSources = sources.flatMap((source) => (
    source.behaviorOverride ? [source.behaviorOverride] : []
  ));
  for (const source of behaviorOverrideSources) {
    lines.push(`import { ${source.importName} } from ${renderTsStringLiteral(source.importPath)};`);
  }
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
  lines.push('> = Object.freeze({');
  for (const source of sources) {
    if (!source.behaviorOverride) continue;
    lines.push(`    ${source.agentId}: ${source.behaviorOverride.importName},`);
  }
  lines.push('});');
  lines.push('');
  return lines.join('\n');
}

function collectBundledPluginUiTranslations(
  pluginPackages: readonly BundledPluginPackage[],
): JsonObject {
  const messagesByLocale = new Map<string, Map<string, { owner: string; value: string }>>();
  for (const pluginPackage of pluginPackages) {
    const contributes = isRecord(pluginPackage.manifest.contributes)
      ? pluginPackage.manifest.contributes
      : {};
    const ui = isRecord(contributes.ui) ? contributes.ui : {};
    const translations = Array.isArray(ui.translations) ? ui.translations : [];
    for (const translation of translations) {
      if (!isRecord(translation) || typeof translation.locale !== 'string' || !isRecord(translation.messages)) {
        throw new Error(`Invalid bundled UI translation contribution in ${pluginPackage.pluginPackageId}`);
      }
      const localeMessages = messagesByLocale.get(translation.locale) ?? new Map();
      messagesByLocale.set(translation.locale, localeMessages);
      for (const [key, value] of Object.entries(translation.messages)) {
        if (typeof value !== 'string') {
          throw new Error(`Invalid bundled UI translation '${key}' in ${pluginPackage.pluginPackageId}`);
        }
        const existing = localeMessages.get(key);
        if (existing) {
          throw new Error(
            `Duplicate bundled UI translation '${translation.locale}:${key}' from ${existing.owner} and ${pluginPackage.pluginPackageId}`,
          );
        }
        localeMessages.set(key, { owner: pluginPackage.pluginPackageId, value });
      }
    }
  }

  return Object.fromEntries(
    [...messagesByLocale.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([locale, messages]) => [
        locale,
        Object.fromEntries(
          [...messages.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => [key, entry.value]),
        ),
      ]),
  ) as JsonObject;
}

function assertDescriptorConnectedServiceLabelTranslations(
  pluginPackages: readonly BundledPluginPackage[],
): void {
  for (const pluginPackage of pluginPackages) {
    const descriptor = pluginPackage.agentUiDescriptor;
    if (!descriptor) continue;

    const labelKey = descriptor.display.connectedService.labelKey;
    if (labelKey === descriptor.display.nameKey) continue;

    const contributes = isRecord(pluginPackage.manifest.contributes)
      ? pluginPackage.manifest.contributes
      : {};
    const ui = isRecord(contributes.ui) ? contributes.ui : {};
    const translations = Array.isArray(ui.translations) ? ui.translations : [];
    const ownsEnglishLabel = translations.some((translation) => (
      isRecord(translation)
      && translation.locale === 'en'
      && isRecord(translation.messages)
      && typeof translation.messages[labelKey] === 'string'
    ));
    if (!ownsEnglishLabel) {
      throw new Error(
        `Invalid agent UI descriptor for ${descriptor.agentId}: display.connectedService.labelKey '${labelKey}' must equal display.nameKey or be declared by the same plugin in contributes.ui.translations locale 'en'`,
      );
    }
  }
}

function renderBundledPluginTranslationsTs(translations: JsonObject): string {
  return [
    '/**',
    ' * GENERATED FILE CONTRACT (G5-bundled-plugin-translations)',
    ' *',
    ' * This file is emitted by:',
    ' * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`',
    ' */',
    '',
    `export const BUNDLED_PLUGIN_TRANSLATIONS = Object.freeze(${renderJsonLiteral(translations)} as const);`,
    '',
    'type KeysOfUnion<T> = T extends T ? keyof T : never;',
    'type BundledPluginTranslationBundle = (typeof BUNDLED_PLUGIN_TRANSLATIONS)[keyof typeof BUNDLED_PLUGIN_TRANSLATIONS];',
    'export type BundledPluginTranslationKey = KeysOfUnion<BundledPluginTranslationBundle> & string;',
    '',
  ].join('\n');
}

function renderBundledSessionAgentBehaviorsTs(sources: readonly AgentSessionBehaviorSource[]): string {
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
  lines.push('export type BundledSessionAgentBehaviorDescriptor = Readonly<{');
  lines.push('    agentId: CanonicalAgentId;');
  lines.push('    descriptor: Readonly<Record<string, unknown>>;');
  lines.push('}>;');
  lines.push('');
  lines.push('export const BUNDLED_CANONICAL_AGENT_SESSION_BEHAVIOR_DESCRIPTORS: Readonly<');
  lines.push('    Partial<Record<CanonicalAgentId, BundledSessionAgentBehaviorDescriptor>>');
  lines.push('> = Object.freeze({');
  for (const source of sources) {
    lines.push(`    ${source.agentId}: Object.freeze({`);
    lines.push(`        agentId: ${renderTsStringLiteral(source.agentId)} as CanonicalAgentId,`);
    lines.push(`        descriptor: Object.freeze(${renderJsonLiteral(source.descriptor)} as const),`);
    lines.push('    }),');
  }
  lines.push('});');
  lines.push('');
  lines.push('export const BUNDLED_CANONICAL_AGENT_SESSION_BEHAVIORS: Readonly<');
  lines.push('    Partial<Record<CanonicalAgentId, SessionProviderBehavior>>');
  lines.push('> = Object.freeze({});');
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
  lines.push('import type { PluginPromptAssetAdapterDescriptor } from \'../pluginPromptAssetAdapterDescriptor\';');
  for (const source of sources) {
    lines.push(
      `import { ${PLUGIN_PROMPT_ASSET_EXPORT_NAME} as ${source.importName} } from ${renderTsStringLiteral(source.importPath)};`,
    );
  }
  lines.push('');
  lines.push('export const BUNDLED_FIRST_PARTY_PLUGIN_PROMPT_ASSET_DESCRIPTORS: readonly PluginPromptAssetAdapterDescriptor[] = Object.freeze([');
  for (const source of sources) {
    lines.push(`  ...${source.importName},`);
  }
  lines.push(']);');
  lines.push('');
  return lines.join('\n');
}

function toBundledVoiceImportPrefix(packageId: BundledFirstPartyVoicePackageId): string {
  return packageId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function renderBundledVoiceEntriesTs(
  sources: readonly BundledFirstPartyVoiceProjectionSource[],
): string {
  const exportName = 'BUNDLED_VOICE_UI_ENTRIES';
  const generatedName = 'BUNDLED_FIRST_PARTY_VOICE_UI_ENTRIES';
  const subpath = 'ui/voice';
  const lines: string[] = [];
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (VOICE-FIRST-PARTY-PROJECTION)');
  lines.push(' *');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`');
  lines.push(' *');
  lines.push(' * Internal first-party build-time projection of inert UI metadata.');
  lines.push(' * Executable activation roots are emitted separately by host platform.');
  lines.push(' */');
  lines.push('');
  lines.push("import type { BundledVoiceUiEntry } from '@happier-dev/bundled-voice-runtime-contract';");
  lines.push('');
  for (const source of sources) {
    const alias = `${toBundledVoiceImportPrefix(source.pluginPackageId)}_${exportName}`;
    lines.push(
      `import { ${exportName} as ${alias} } from '${source.packageName}/${subpath}';`,
    );
  }
  if (sources.length > 0) lines.push('');
  if (sources.length === 0) {
    lines.push(`export const ${generatedName} = Object.freeze([]);`);
  } else {
    lines.push(`export const ${generatedName} = Object.freeze([`);
    for (const source of sources) {
      lines.push(`  ...${toBundledVoiceImportPrefix(source.pluginPackageId)}_${exportName},`);
    }
    lines.push(']) satisfies readonly BundledVoiceUiEntry[];');
  }
  lines.push('');
  return lines.join('\n');
}

function renderBundledVoiceRuntimeEntriesTs(
  sources: readonly BundledFirstPartyVoiceProjectionSource[],
  platform: BundledVoiceRuntimePlatform,
): string {
  const exportName = 'BUNDLED_VOICE_UI_ENTRIES';
  const subpath = 'ui/voice';
  const applicableSources = sources.filter(
    (candidate) => candidate.hasConversationProvider
      && candidate.conversationPlatforms.includes(platform),
  );
  const lines: string[] = [];
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (VOICE-FIRST-PARTY-RUNTIME-PROJECTION)');
  lines.push(' *');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`');
  lines.push(' *');
  lines.push(` * Executable first-party Voice activation roots for ${platform}.`);
  lines.push(' * Contributions that do not declare this host platform are absent.');
  lines.push(' */');
  lines.push('');
  lines.push(applicableSources.length > 0
    ? "import { createBundledConversationRuntimeEntries, type BundledConversationRuntimeEntry } from './bundledConversationRuntimeEntries';"
    : "import type { BundledConversationRuntimeEntry } from './bundledConversationRuntimeEntries';");
  for (const source of applicableSources) {
    const prefix = toBundledVoiceImportPrefix(source.pluginPackageId);
    lines.push(
      `import { ${exportName} as ${prefix}_${exportName}, activate as ${prefix}_BUNDLED_VOICE_ACTIVATE } from '${source.packageName}/${subpath}';`,
    );
  }
  lines.push('');
  for (const source of applicableSources) {
    const prefix = toBundledVoiceImportPrefix(source.pluginPackageId);
    lines.push(`const ${prefix}_BUNDLED_PUBLIC_VOICE_ACTIVATIONS = createBundledConversationRuntimeEntries(`);
    lines.push(`  ${prefix}_${exportName},`);
    lines.push(`  ${prefix}_BUNDLED_VOICE_ACTIVATE,`);
    lines.push(');');
  }
  if (applicableSources.length > 0) lines.push('');
  lines.push('export const BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES = Object.freeze([');
  for (const source of applicableSources) {
    lines.push(`  ...${toBundledVoiceImportPrefix(source.pluginPackageId)}_BUNDLED_PUBLIC_VOICE_ACTIVATIONS,`);
  }
  lines.push(']) satisfies readonly BundledConversationRuntimeEntry[];');
  lines.push('');
  lines.push('/**');
  lines.push(' * Exact generated first-party entry identities admitted to the hosted');
  lines.push(' * conversation service. This is intentionally separate from provider ids and');
  lines.push(' * manifest metadata so copied or colliding external entries fail closed.');
  lines.push(' */');
  lines.push('export const BUNDLED_FIRST_PARTY_HOSTED_CONVERSATION_RUNTIME_ENTRIES = Object.freeze([');
  const elevenLabsSource = applicableSources.find(
    (candidate) => candidate.pluginPackageId === 'elevenlabs',
  );
  if (elevenLabsSource) {
    lines.push(`  ...${toBundledVoiceImportPrefix(elevenLabsSource.pluginPackageId)}_BUNDLED_PUBLIC_VOICE_ACTIVATIONS,`);
  }
  lines.push(']) satisfies readonly BundledConversationRuntimeEntry[];');
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

function removeRetiredGeneratedOutput(filePath: string, mode: Mode): void {
  if (!existsSync(filePath)) return;
  if (mode === 'check') {
    throw new Error(`retired generated output still exists: ${filePath}`);
  }
  unlinkSync(filePath);
}

async function generateBundledPluginEntries(
  options: GeneratorOptions,
  dependencies: GeneratorWorkspaceDependencies,
): Promise<void> {
  // Discover and validate every package before mutating host membership. A rejected
  // first-party identity/export must not leave package.json or generated outputs in a
  // partially admitted state.
  const bundledPluginPackageNames = readBundledPluginPackageNames(options.rootDir);
  const pluginPackages = await readBundledPluginPackages(
    options.rootDir,
    bundledPluginPackageNames,
    dependencies,
  );
  const builtInLegacyConnectedAccountCompatibility =
    collectBuiltInLegacyConnectedAccountCompatibility(
      options.rootDir,
      pluginPackages,
      dependencies,
    );
  assertDescriptorConnectedServiceLabelTranslations(pluginPackages);
  const todayUtc = new Date().toISOString().slice(0, 10);
  for (const entry of pluginPackages) {
    const providerContributions = readManifestContributionArray(entry.manifest, 'providers');
    if (providerContributions.length === 0) continue;
    readAndAssertBundledProviderVerificationsV1({
      buildQualifiedContributionKey: dependencies.protocol.buildQualifiedPluginContributionKey,
      rootDir: options.rootDir,
      pluginPackageId: entry.pluginPackageId,
      pluginId: entry.pluginId,
      contributions: providerContributions,
      todayUtc,
    });
  }
  const bundledVoiceProjectionSources = collectBundledFirstPartyVoiceProjectionSources(
    options.rootDir,
    pluginPackages,
  );
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
  const generatedAgentIds = collectGeneratedAgentIds(bundledAgentDefinitionIds, dependencies);
  const agentDefinitionsById = Object.fromEntries(
    pluginPackages
      .filter((entry): entry is AgentBundledPluginPackage => (
        typeof entry.agentId === 'string' && entry.agentDefinition !== undefined
      ))
      .map((entry) => [entry.agentId, entry.agentDefinition]),
  );

  const cliOutPath = resolve(options.rootDir, 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPlugins.ts');
  const cliArtifactsOutPath = resolve(options.rootDir, 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPluginArtifacts.ts');
  const uiOutPath = resolve(options.rootDir, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts');
  const uiTranslationsOutPath = resolve(
    options.rootDir,
    'apps/ui/sources/text/bundledPluginTranslations.generated.ts',
  );
  const uiVoiceEntriesOutPath = resolve(
    options.rootDir,
    'apps/ui/sources/voice/registry/generatedBundledVoiceEntries.ts',
  );
  const uiVoiceRuntimeEntriesOutPaths = Object.freeze({
    web: resolve(
      options.rootDir,
      'apps/ui/sources/voice/registry/generatedBundledVoiceRuntimeEntries.ts',
    ),
    ios: resolve(
      options.rootDir,
      'apps/ui/sources/voice/registry/generatedBundledVoiceRuntimeEntries.ios.ts',
    ),
    android: resolve(
      options.rootDir,
      'apps/ui/sources/voice/registry/generatedBundledVoiceRuntimeEntries.android.ts',
    ),
  } satisfies Readonly<Record<BundledVoiceRuntimePlatform, string>>);
  const uiBehaviorOverridesOutPath = resolve(
    options.rootDir,
    'apps/ui/sources/agents/registry/generatedBundledPluginEntries.uiBehaviorOverrides.ts',
  );
  const sessionAgentBehaviorsOutPath = resolve(
    options.rootDir,
    'apps/ui/sources/agents/registry/generatedBundledPluginEntries.sessionAgentBehaviors.ts',
  );
  const retiredAgentSettingsOutPath = resolve(
    options.rootDir,
    'apps/ui/sources/agents/registry/generatedBundledPluginEntries.agentSettings.ts',
  );
  const visibleMessageResolversOutPath = resolve(
    options.rootDir,
    'apps/ui/sources/agents/registry/generatedBundledPluginEntries.visibleMessageResolvers.ts',
  );
  const agentsOutPath = resolve(options.rootDir, 'packages/agents/src/generated/bundledAgentDefinitions.ts');
  const retiredHostAgentSettingsOutPath = resolve(
    options.rootDir,
    'packages/agents/src/agentSettings/generated/bundledAgentSettings.ts',
  );
  const agentIdsOutPath = resolve(options.rootDir, 'packages/agents/src/generated/agentIds.ts');
  const sessionControlAdaptersOutPath = resolve(options.rootDir, 'packages/agents/src/generated/sessionControlAdapters.ts');
  const runtimeDescriptorReadersOutPath = resolve(options.rootDir, 'packages/agents/src/generated/runtimeDescriptorReaders.ts');
  const protocolAgentProviderIdsV1OutPath = resolve(
    options.rootDir,
    'packages/protocol/src/generated/providers/agentProviderIdsV1.ts',
  );
  const protocolBuiltInLegacyConnectedAccountCompatibilityOutPath = resolve(
    options.rootDir,
    'packages/protocol/src/connect/generatedBuiltInLegacyConnectedAccountCompatibility.ts',
  );
  const protocolRuntimeDescriptorContributionsOutPath = resolve(
    options.rootDir,
    'packages/protocol/src/agents/generated/runtime/descriptorContributionsV1.ts',
  );
  const protocolSessionPresentationCompatV1OutPath = resolve(
    options.rootDir,
    'packages/protocol/src/agents/generated/sessionPresentationCompatV1.ts',
  );
  const protocolRuntimeDescriptorContributions = collectProtocolRuntimeDescriptorContributions(
    pluginPackages,
    options.rootDir,
  );
  const protocolRuntimeDescriptorModuleOutputs = protocolRuntimeDescriptorContributions.map((contribution) => ({
    outPath: resolve(
      options.rootDir,
      'packages/protocol/src/agents/generated/runtime/descriptors',
      contribution.moduleFileName,
    ),
    out: renderGeneratedProtocolRuntimeDescriptorModuleTs(contribution),
  }));
  const protocolBuiltInBackendProfilesOutPath = resolve(
    options.rootDir,
    'packages/protocol/src/agents/generated/profiles/builtInBackendProfiles.ts',
  );
  const protocolMemoryDefaultsOutPath = resolve(
    options.rootDir,
    'packages/protocol/src/agents/generated/memory/defaults.ts',
  );
  const protocolExternalSessionSourcesOutPath = resolve(
    options.rootDir,
    'packages/protocol/src/agents/generated/externalSession/sources.ts',
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
  );
  const promptAssetPluginDescriptorsOutPath = resolve(
    options.rootDir,
    'apps/cli/src/prompts/assets/generated/pluginDescriptors.ts',
  );

  const uiBehaviorOverrideSources = collectAgentUiBehaviorOverrideSources(pluginPackages);
  const sessionAgentBehaviorSources = collectAgentSessionBehaviorSources(pluginPackages);
  const visibleMessageResolverSources = collectVisibleMessageResolverSources(pluginPackages);
  const promptAssetContributionSources = collectPromptAssetContributionSources(pluginPackages);
  const bundledPluginUiTranslations = collectBundledPluginUiTranslations(pluginPackages);

  const cliOut = renderCliBundledPluginEntriesTs({ pluginPackages });
  const cliArtifactsOut = renderCliBundledPluginArtifactsTs(pluginPackages);

  const agentsOut = renderBundledAgentDefinitionsTs({ agentIds: bundledAgentDefinitionIds, agentDefinitionsById });
  const protocolSessionPresentationCompatV1Out =
    renderProtocolSessionPresentationCompatV1Ts({
      agentIds: bundledAgentDefinitionIds,
      agentDefinitionsById,
    });
  const agentIdsOut = renderAgentIdsTs(generatedAgentIds);
  const sessionControlAdaptersOut = renderAgentSessionControlAdaptersTs(
    collectSessionControlAdapterContributions(pluginPackages),
  );
  const runtimeDescriptorReadersOut = renderAgentRuntimeDescriptorReadersTs(
    collectRuntimeDescriptorReaderContributions(pluginPackages),
  );
  const protocolAgentProviderIdsV1Out = renderProtocolAgentProviderIdsV1Ts(
    collectProtocolAgentProviderIdsV1(generatedAgentIds),
  );
  const protocolBuiltInLegacyConnectedAccountCompatibilityOut =
    renderProtocolBuiltInLegacyConnectedAccountCompatibilityTs(
      builtInLegacyConnectedAccountCompatibility,
    );
  const protocolRuntimeDescriptorContributionsOut = renderProtocolRuntimeDescriptorContributionsV1Ts(
    protocolRuntimeDescriptorContributions,
  );
  const protocolBuiltInBackendProfilesOut = renderGeneratedBuiltInBackendProfilesTs(
    protocolBuiltInBackendProfilesContributions,
    collectProviderMigrationSourceProfileIds(pluginPackages),
  );
  const protocolMemoryDefaultsOut = renderGeneratedMemoryDefaultsTs(
    protocolMemoryDefaultsContributions,
  );
  const protocolExternalSessionSourcesOut = renderGeneratedExternalSessionSourcesTs(
    protocolExternalSessionSourceContributions,
  );
  const uiOut = renderUiBundledPluginEntriesTs({ packageNames, pluginPackages });
  const uiTranslationsOut = renderBundledPluginTranslationsTs(bundledPluginUiTranslations);
  const uiBehaviorOverridesOut = renderBundledUiBehaviorOverridesTs(uiBehaviorOverrideSources);
  const sessionAgentBehaviorsOut = renderBundledSessionAgentBehaviorsTs(sessionAgentBehaviorSources);
  const visibleMessageResolversOut = renderBundledVisibleMessageResolversTs(visibleMessageResolverSources);
  const promptAssetPluginDescriptorsOut = renderCliPromptAssetPluginDescriptorsTs(promptAssetContributionSources);
  const uiVoiceEntriesOut = renderBundledVoiceEntriesTs(bundledVoiceProjectionSources);
  const uiVoiceRuntimeEntriesOut = Object.freeze(Object.fromEntries(
    BUNDLED_VOICE_RUNTIME_PLATFORMS.map((platform) => [
      platform,
      renderBundledVoiceRuntimeEntriesTs(bundledVoiceProjectionSources, platform),
    ]),
  ) as Record<BundledVoiceRuntimePlatform, string>);

  syncCliBundledPluginMembership({
    rootDir: options.rootDir,
    mode: options.mode,
  });
  syncBundledVoiceUiPackageDependencies({
    rootDir: options.rootDir,
    mode: options.mode,
    sources: bundledVoiceProjectionSources,
  });
  removeRetiredGeneratedOutput(retiredAgentSettingsOutPath, options.mode);
  removeRetiredGeneratedOutput(retiredHostAgentSettingsOutPath, options.mode);

  if (options.mode === 'check') {
    assertGeneratedOutputMatches(cliOutPath, cliOut);
    assertGeneratedOutputMatches(cliArtifactsOutPath, cliArtifactsOut);
    assertGeneratedOutputMatches(agentsOutPath, agentsOut);
    assertGeneratedOutputMatches(agentIdsOutPath, agentIdsOut);
    assertGeneratedOutputMatches(sessionControlAdaptersOutPath, sessionControlAdaptersOut);
    assertGeneratedOutputMatches(runtimeDescriptorReadersOutPath, runtimeDescriptorReadersOut);
    assertGeneratedOutputMatches(protocolAgentProviderIdsV1OutPath, protocolAgentProviderIdsV1Out);
    assertGeneratedOutputMatches(
      protocolBuiltInLegacyConnectedAccountCompatibilityOutPath,
      protocolBuiltInLegacyConnectedAccountCompatibilityOut,
    );
    assertGeneratedOutputMatches(
      protocolRuntimeDescriptorContributionsOutPath,
      protocolRuntimeDescriptorContributionsOut,
    );
    assertGeneratedOutputMatches(
      protocolSessionPresentationCompatV1OutPath,
      protocolSessionPresentationCompatV1Out,
    );
    for (const output of protocolRuntimeDescriptorModuleOutputs) {
      assertGeneratedOutputMatches(output.outPath, output.out);
    }
    assertGeneratedOutputMatches(protocolBuiltInBackendProfilesOutPath, protocolBuiltInBackendProfilesOut);
    assertGeneratedOutputMatches(protocolMemoryDefaultsOutPath, protocolMemoryDefaultsOut);
    assertGeneratedOutputMatches(protocolExternalSessionSourcesOutPath, protocolExternalSessionSourcesOut);
    assertGeneratedOutputMatches(uiOutPath, uiOut);
    assertGeneratedOutputMatches(uiTranslationsOutPath, uiTranslationsOut);
    assertGeneratedOutputMatches(uiBehaviorOverridesOutPath, uiBehaviorOverridesOut);
    assertGeneratedOutputMatches(sessionAgentBehaviorsOutPath, sessionAgentBehaviorsOut);
    assertGeneratedOutputMatches(visibleMessageResolversOutPath, visibleMessageResolversOut);
    assertGeneratedOutputMatches(promptAssetPluginDescriptorsOutPath, promptAssetPluginDescriptorsOut);
    assertGeneratedOutputMatches(uiVoiceEntriesOutPath, uiVoiceEntriesOut);
    for (const platform of BUNDLED_VOICE_RUNTIME_PLATFORMS) {
      assertGeneratedOutputMatches(
        uiVoiceRuntimeEntriesOutPaths[platform],
        uiVoiceRuntimeEntriesOut[platform],
      );
    }
    return;
  }

  writeFileAtomic(cliOutPath, cliOut);
  writeFileAtomic(cliArtifactsOutPath, cliArtifactsOut);
  writeFileAtomic(agentsOutPath, agentsOut);
  writeFileAtomic(agentIdsOutPath, agentIdsOut);
  writeFileAtomic(sessionControlAdaptersOutPath, sessionControlAdaptersOut);
  writeFileAtomic(runtimeDescriptorReadersOutPath, runtimeDescriptorReadersOut);
  writeFileAtomic(protocolAgentProviderIdsV1OutPath, protocolAgentProviderIdsV1Out);
  writeFileAtomic(
    protocolBuiltInLegacyConnectedAccountCompatibilityOutPath,
    protocolBuiltInLegacyConnectedAccountCompatibilityOut,
  );
  writeFileAtomic(protocolRuntimeDescriptorContributionsOutPath, protocolRuntimeDescriptorContributionsOut);
  writeFileAtomic(
    protocolSessionPresentationCompatV1OutPath,
    protocolSessionPresentationCompatV1Out,
  );
  for (const output of protocolRuntimeDescriptorModuleOutputs) {
    writeFileAtomic(output.outPath, output.out);
  }
  writeFileAtomic(protocolBuiltInBackendProfilesOutPath, protocolBuiltInBackendProfilesOut);
  writeFileAtomic(protocolMemoryDefaultsOutPath, protocolMemoryDefaultsOut);
  writeFileAtomic(protocolExternalSessionSourcesOutPath, protocolExternalSessionSourcesOut);
  writeFileAtomic(uiOutPath, uiOut);
  writeFileAtomic(uiTranslationsOutPath, uiTranslationsOut);
  writeFileAtomic(uiBehaviorOverridesOutPath, uiBehaviorOverridesOut);
  writeFileAtomic(sessionAgentBehaviorsOutPath, sessionAgentBehaviorsOut);
  writeFileAtomic(visibleMessageResolversOutPath, visibleMessageResolversOut);
  writeFileAtomic(promptAssetPluginDescriptorsOutPath, promptAssetPluginDescriptorsOut);
  writeFileAtomic(uiVoiceEntriesOutPath, uiVoiceEntriesOut);
  for (const platform of BUNDLED_VOICE_RUNTIME_PLATFORMS) {
    writeFileAtomic(
      uiVoiceRuntimeEntriesOutPaths[platform],
      uiVoiceRuntimeEntriesOut[platform],
    );
  }
}

async function withGeneratorWorkspaceLock<T>(
  rootDir: string,
  operation: (dependencies: GeneratorWorkspaceDependencies) => Promise<T>,
): Promise<T> {
  return await withWorkspaceBundleLock(
    async () => await operation(await loadGeneratorWorkspaceDependencies()),
    {
      lockPath: resolveWorkspaceBundleLockPath(rootDir),
      heldLockValue: process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD,
      errorLabel: 'bundled plugin generator workspace lock',
    },
  );
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseCliArgs(argv);
  await withGeneratorWorkspaceLock(
    options.rootDir,
    async (dependencies) => await generateBundledPluginEntries(options, dependencies),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
