import {
  AcpBackendAuthConfigV1Schema,
  AcpBackendCapabilitiesV1Schema,
  AcpCatalogTransportProfileV1Schema,
  McpValueRefV1Schema,
} from '@happier-dev/protocol';
import type {
  AcpBackendAuthConfigV1,
  AcpBackendCapabilitiesV1,
  AcpCatalogTransportProfileV1,
  McpValueRefV1,
} from '@happier-dev/protocol';
import { resolveMergedContributionRegistry } from '@/extensions/registry/createResolvedContributionRegistry';
import { loadInstalledPlugins, type LoadedPlugin } from '@/extensions/plugins/loader/loadInstalledPlugins';
import type { ResolvedBackendContribution } from '@/extensions/registry/types';

import { readAcpCatalogSettingsFromAccountSettings } from '../readAcpCatalogSettingsFromAccountSettings';

export type ResolvedConfiguredAcpBackend = Readonly<{
  backendId: string;
  name: string;
  title: string;
  description?: string;
  command: string;
  args: ReadonlyArray<string>;
  env: Readonly<Record<string, McpValueRefV1>>;
  auth?: AcpBackendAuthConfigV1;
  transportProfile: AcpCatalogTransportProfileV1;
  capabilities: AcpBackendCapabilitiesV1;
  defaultMode?: string;
  defaultModel?: string;
}>;

type AccountSettingsConfiguredAcpBackend = ReturnType<typeof readAcpCatalogSettingsFromAccountSettings>['backends'][number];

function resolveConfiguredAcpBackendFromAccountSettingsEntry(
  backend: AccountSettingsConfiguredAcpBackend,
): ResolvedConfiguredAcpBackend {
  const backendRecord = backend as Record<string, unknown>;
  const defaultMode = typeof backendRecord.defaultMode === 'string' ? backendRecord.defaultMode : undefined;
  const defaultModel = typeof backendRecord.defaultModel === 'string' ? backendRecord.defaultModel : undefined;

  return {
    backendId: backend.id,
    name: backend.name,
    title: backend.title,
    description: backend.description,
    command: backend.command,
    args: [...backend.args],
    env: { ...backend.env },
    auth: backend.auth,
    transportProfile: backend.transportProfile,
    capabilities: backend.capabilities,
    defaultMode,
    defaultModel,
  };
}

export function resolveConfiguredAcpBackendFromAccountSettings(
  settings: Readonly<Record<string, unknown>>,
  backendId: string,
): ResolvedConfiguredAcpBackend | null {
  const acpCatalog = readAcpCatalogSettingsFromAccountSettings(settings);
  const backend = acpCatalog.backends.find((entry) => entry.id === backendId) ?? null;
  return backend ? resolveConfiguredAcpBackendFromAccountSettingsEntry(backend) : null;
}

const DEFAULT_ACP_CAPABILITIES: AcpBackendCapabilitiesV1 = AcpBackendCapabilitiesV1Schema.parse({});
const DEFAULT_ACP_TRANSPORT_PROFILE: AcpCatalogTransportProfileV1 = AcpCatalogTransportProfileV1Schema.parse('generic');

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Readonly<Record<string, unknown>>;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readOptionalStringArray(value: unknown): ReadonlyArray<string> | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((entry) => typeof entry === 'string')) return undefined;
  return [...value];
}

function parsePluginAcpEnv(acpEnv: unknown): Record<string, McpValueRefV1> | null {
  const envRecord = asRecord(acpEnv);
  if (!envRecord) return null;

  const out: Record<string, McpValueRefV1> = {};
  for (const [key, value] of Object.entries(envRecord)) {
    const parsed = McpValueRefV1Schema.safeParse(value);
    if (!parsed.success) {
      if (typeof value !== 'string') return null;
      out[key] = { t: 'literal', v: value };
      continue;
    }
    out[key] = parsed.data;
  }
  return out;
}

function parseLaunchLiteralEnv(launchEnv: unknown): Record<string, McpValueRefV1> | null {
  const envRecord = asRecord(launchEnv);
  if (!envRecord) return null;

  const out: Record<string, McpValueRefV1> = {};
  for (const [key, value] of Object.entries(envRecord)) {
    if (typeof value !== 'string') return null;
    out[key] = { t: 'literal', v: value };
  }
  return out;
}

function resolvePluginAcpEnv(acpRecord: Readonly<Record<string, unknown>> | null, launchRecord: Readonly<Record<string, unknown>> | null): Record<string, McpValueRefV1> | null {
  if (acpRecord && Object.prototype.hasOwnProperty.call(acpRecord, 'env')) {
    return parsePluginAcpEnv(acpRecord.env);
  }
  if (launchRecord && Object.prototype.hasOwnProperty.call(launchRecord, 'env')) {
    return parseLaunchLiteralEnv(launchRecord.env);
  }
  return {};
}

function coerceSupportHintFromBoolean(value: unknown): AcpBackendCapabilitiesV1['supportsModes'] | undefined {
  if (typeof value !== 'boolean') return undefined;
  return value ? 'yes' : 'no';
}

function resolvePluginAcpCapabilities(
  acpRecord: Readonly<Record<string, unknown>> | null,
  backendDefinitionRecord: Readonly<Record<string, unknown>>,
): AcpBackendCapabilitiesV1 | null {
  if (acpRecord && Object.prototype.hasOwnProperty.call(acpRecord, 'capabilities')) {
    const parsed = AcpBackendCapabilitiesV1Schema.safeParse(acpRecord.capabilities);
    return parsed.success ? parsed.data : null;
  }

  const backendCapabilities = asRecord(backendDefinitionRecord.capabilities);
  if (!backendCapabilities) {
    return { ...DEFAULT_ACP_CAPABILITIES };
  }

  return {
    supportsLoadSession: typeof backendCapabilities.supportsLoadSession === 'boolean'
      ? backendCapabilities.supportsLoadSession
      : DEFAULT_ACP_CAPABILITIES.supportsLoadSession,
    supportsModes: coerceSupportHintFromBoolean(backendCapabilities.supportsModes) ?? DEFAULT_ACP_CAPABILITIES.supportsModes,
    supportsModels: coerceSupportHintFromBoolean(backendCapabilities.supportsModels) ?? DEFAULT_ACP_CAPABILITIES.supportsModels,
    supportsConfigOptions: coerceSupportHintFromBoolean(backendCapabilities.supportsConfigOptions) ?? DEFAULT_ACP_CAPABILITIES.supportsConfigOptions,
    promptImageSupport: coerceSupportHintFromBoolean(backendCapabilities.promptImageSupport) ?? DEFAULT_ACP_CAPABILITIES.promptImageSupport,
  };
}

function resolvePluginAcpTransportProfile(acpRecord: Readonly<Record<string, unknown>> | null): AcpCatalogTransportProfileV1 | null {
  if (!acpRecord || !Object.prototype.hasOwnProperty.call(acpRecord, 'transportProfile')) {
    return DEFAULT_ACP_TRANSPORT_PROFILE;
  }
  const parsed = AcpCatalogTransportProfileV1Schema.safeParse(acpRecord.transportProfile);
  return parsed.success ? parsed.data : null;
}

function resolvePluginAcpAuth(acpRecord: Readonly<Record<string, unknown>> | null): AcpBackendAuthConfigV1 | undefined | null {
  if (!acpRecord || !Object.prototype.hasOwnProperty.call(acpRecord, 'auth')) {
    return undefined;
  }
  const parsed = AcpBackendAuthConfigV1Schema.safeParse(acpRecord.auth);
  return parsed.success ? parsed.data : null;
}

function resolveConfiguredAcpBackendFromPluginBackendDefinition(
  backendDefinition: Readonly<Record<string, unknown>> | null,
  backendId: string,
): ResolvedConfiguredAcpBackend | null {
  if (!backendDefinition) return null;
  const backendDefinitionRecord = asRecord(backendDefinition);
  if (!backendDefinitionRecord) return null;
  if (backendDefinitionRecord.runtimeKind !== 'acp') return null;

  const acpRecord = asRecord(backendDefinitionRecord.acp);
  const launchRecord = asRecord(backendDefinitionRecord.launch);

  const command = readOptionalString(acpRecord?.command) ?? readOptionalString(launchRecord?.command);
  if (!command) return null;

  const args = readOptionalStringArray(acpRecord?.args) ?? readOptionalStringArray(launchRecord?.args) ?? [];
  const env = resolvePluginAcpEnv(acpRecord, launchRecord);
  if (!env) return null;

  const transportProfile = resolvePluginAcpTransportProfile(acpRecord);
  if (!transportProfile) return null;
  const auth = resolvePluginAcpAuth(acpRecord);
  if (auth === null) return null;

  const capabilities = resolvePluginAcpCapabilities(acpRecord, backendDefinitionRecord);
  if (!capabilities) return null;

  const name = readOptionalString(acpRecord?.name) ?? backendId;
  const title = readOptionalString(acpRecord?.title) ?? backendId;

  return {
    backendId,
    name,
    title,
    description: readOptionalString(acpRecord?.description),
    command,
    args,
    env,
    ...(auth ? { auth } : {}),
    transportProfile,
    capabilities,
    defaultMode: readOptionalString(acpRecord?.defaultMode),
    defaultModel: readOptionalString(acpRecord?.defaultModel),
  };
}

async function listPluginConfiguredAcpBackends(params: Readonly<{
  happyHomeDir?: string;
}>): Promise<ReadonlyArray<ResolvedConfiguredAcpBackend>> {
  const mergedRegistry = await resolveMergedContributionRegistry({ happyHomeDir: params.happyHomeDir });
  const loadedPlugins = await loadInstalledPlugins({ happyHomeDir: params.happyHomeDir });
  const loadedPluginsById = new Map<string, LoadedPlugin>();
  for (const plugin of loadedPlugins.loadedPlugins) {
    loadedPluginsById.set(plugin.pluginId, plugin);
  }
  const resolved: ResolvedConfiguredAcpBackend[] = [];
  for (const backendContribution of mergedRegistry.backendDefinitionsById.values()) {
    if (backendContribution.source !== 'plugin' || !backendContribution.pluginId) continue;
    const plugin = loadedPluginsById.get(backendContribution.pluginId);
    if (!plugin) continue;
    const rawBackend = plugin.manifest.contributions.backends.find((entry) => entry.id === backendContribution.id) ?? null;
    const backend = resolveConfiguredAcpBackendFromPluginBackendDefinition(rawBackend, backendContribution.id);
    if (backend) {
      resolved.push(backend);
    }
  }
  return resolved;
}

export async function listConfiguredAcpBackendsFromAccountSettingsOrPlugins(params: Readonly<{
  settings: Readonly<Record<string, unknown>>;
  happyHomeDir?: string;
}>): Promise<ReadonlyArray<ResolvedConfiguredAcpBackend>> {
  const accountSettingsBackends = readAcpCatalogSettingsFromAccountSettings(params.settings)
    .backends
    .map((backend) => resolveConfiguredAcpBackendFromAccountSettingsEntry(backend));
  const byBackendId = new Map<string, ResolvedConfiguredAcpBackend>();
  for (const backend of accountSettingsBackends) {
    byBackendId.set(backend.backendId, backend);
  }

  const pluginBackends = await listPluginConfiguredAcpBackends({ happyHomeDir: params.happyHomeDir });
  for (const backend of pluginBackends) {
    if (!byBackendId.has(backend.backendId)) {
      byBackendId.set(backend.backendId, backend);
    }
  }

  return [...byBackendId.values()];
}

export async function resolveConfiguredAcpBackendFromAccountSettingsOrPlugins(params: Readonly<{
  settings: Readonly<Record<string, unknown>>;
  backendId: string;
  happyHomeDir?: string;
}>): Promise<ResolvedConfiguredAcpBackend | null> {
  const accountSettingsBackend = resolveConfiguredAcpBackendFromAccountSettings(params.settings, params.backendId);
  if (accountSettingsBackend) return accountSettingsBackend;

  const pluginBackends = await listPluginConfiguredAcpBackends({ happyHomeDir: params.happyHomeDir });
  return pluginBackends.find((backend) => backend.backendId === params.backendId) ?? null;
}
