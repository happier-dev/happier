import {
  AcpBackendAuthConfigV1Schema,
  AcpBackendCapabilitiesV1Schema,
  AcpCatalogTransportProfileV1Schema,
} from '@happier-dev/protocol';
import type {
  AcpBackendAuthConfigV1,
  AcpBackendCapabilitiesV1,
  AcpCatalogTransportProfileV1,
  McpValueRefV1,
} from '@happier-dev/protocol';
import type {
  AcpBootstrapV1,
  AcpMcpInputPolicyV1,
  AcpMessageMetaHooksV1,
  AcpPermissionModeArgvSpecV1,
  AcpTimeoutsV1,
  AcpTransportLifecycleV1,
} from '@happier-dev/plugin-sdk';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { loadInstalledPlugins, type LoadedPlugin } from '@/plugins/discovery/load/installed';

import { readAcpCatalogSettingsFromAccountSettings } from '../readAcpCatalogSettingsFromAccountSettings';
import { normalizePluginBackendContributionAcpDefinition } from '../../runtime/definition/plugin';
import type { AcpRuntimeDefinitionV1 } from '../../runtime/definition/_types';

export type ResolvedConfiguredAcpBackend = Readonly<{
  backendId: string;
  name: string;
  title: string;
  description?: string;
  command: string;
  args: ReadonlyArray<string>;
  launch?: Readonly<
    | {
        kind: 'executable';
        command: string;
        args: ReadonlyArray<string>;
      }
    | {
        kind: 'agent-cli';
        agentId: string;
        args: ReadonlyArray<string>;
      }
  >;
  env: Readonly<Record<string, McpValueRefV1>>;
  auth?: AcpBackendAuthConfigV1;
  transportProfile: AcpCatalogTransportProfileV1;
  capabilities: AcpBackendCapabilitiesV1;
  defaultMode?: string;
  defaultModel?: string;
  timeouts?: AcpTimeoutsV1;
  fsEnabled?: boolean;
  transportLifecycle?: AcpTransportLifecycleV1;
  permissionModeArgv?: AcpPermissionModeArgvSpecV1;
  sessionIdHeaderName?: string;
  bootstrap?: AcpBootstrapV1;
  messageMeta?: AcpMessageMetaHooksV1;
  mcp?: AcpMcpInputPolicyV1;
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
    launch: {
      kind: 'executable',
      command: backend.command,
      args: [...backend.args],
    },
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

function resolvePluginAcpAuth(definition: AcpRuntimeDefinitionV1): AcpBackendAuthConfigV1 | undefined | null {
  if (!definition.auth?.config) {
    return undefined;
  }
  const parsed = AcpBackendAuthConfigV1Schema.safeParse(definition.auth.config);
  return parsed.success ? parsed.data : null;
}

function coerceSupportHintFromFinalFlag(value: unknown): AcpBackendCapabilitiesV1['supportsModes'] | undefined {
  if (typeof value === 'boolean') {
    return value ? 'yes' : 'no';
  }
  if (value === 'yes' || value === 'no') {
    return value;
  }
  if (value === 'unknown') {
    return 'unknown';
  }
  return undefined;
}

function resolveFinalPluginAcpCapabilities(
  definition: AcpRuntimeDefinitionV1,
): AcpBackendCapabilitiesV1 {
  const capabilities = definition.capabilities;

  return {
    supportsLoadSession: typeof capabilities.supportsLoadSession === 'boolean'
      ? capabilities.supportsLoadSession
      : typeof capabilities.supportsResume === 'boolean'
        ? capabilities.supportsResume
        : DEFAULT_ACP_CAPABILITIES.supportsLoadSession,
    supportsModes: coerceSupportHintFromFinalFlag(capabilities.supportsModes) ?? DEFAULT_ACP_CAPABILITIES.supportsModes,
    supportsModels: coerceSupportHintFromFinalFlag(capabilities.supportsModels) ?? DEFAULT_ACP_CAPABILITIES.supportsModels,
    supportsConfigOptions: coerceSupportHintFromFinalFlag(capabilities.supportsConfigOptions) ?? DEFAULT_ACP_CAPABILITIES.supportsConfigOptions,
    promptImageSupport: coerceSupportHintFromFinalFlag(capabilities.promptImageSupport)
      ?? coerceSupportHintFromFinalFlag(capabilities.supportsPromptImages)
      ?? DEFAULT_ACP_CAPABILITIES.promptImageSupport,
  };
}

function mergePluginFinalAcpEnv(
  definitionEnv: Readonly<Record<string, string>>,
  launchEnv: Readonly<Record<string, string>> | undefined,
): Record<string, McpValueRefV1> | null {
  const merged: Record<string, McpValueRefV1> = {};
  for (const source of [definitionEnv, launchEnv]) {
    if (source === undefined) continue;
    const parsed = parseLaunchLiteralEnv(source);
    if (!parsed) return null;
    Object.assign(merged, parsed);
  }
  return merged;
}

function resolveFinalPluginAcpLaunch(
  definition: AcpRuntimeDefinitionV1,
): ResolvedConfiguredAcpBackend['launch'] | null {
  const transport = definition.transport;
  if (transport.kind !== 'stdio') return null;
  if (transport.launch.kind === 'executable') {
    const command = readOptionalString(transport.launch.command);
    if (!command) return null;
    return {
      kind: 'executable',
      command,
      args: [...(transport.launch.args ?? [])],
    };
  }

  if (transport.launch.kind !== 'agent-cli') return null;
  const agentId = readOptionalString(transport.launch.agentId);
  if (!agentId) return null;
  return {
    kind: 'agent-cli',
    agentId,
    args: [...(transport.launch.args ?? [])],
  };
}

function resolveFinalPluginAcpBackendDefinition(
  backendDefinitionRecord: Readonly<Record<string, unknown>>,
  backendId: string,
  pluginId?: string,
): ResolvedConfiguredAcpBackend | null {
  let definition: AcpRuntimeDefinitionV1;
  try {
    definition = normalizePluginBackendContributionAcpDefinition({
      pluginId,
      backend: backendDefinitionRecord,
    });
  } catch {
    return null;
  }

  const launch = resolveFinalPluginAcpLaunch(definition);
  if (!launch) return null;
  const transport = definition.transport;
  if (transport.kind !== 'stdio') return null;
  const env = mergePluginFinalAcpEnv(definition.launchEnv, transport.launch.env);
  if (!env) return null;

  const title = readOptionalString(definition.ux.title) ?? backendId;
  const name = readOptionalString(definition.ux.name) ?? backendId;
  const auth = resolvePluginAcpAuth(definition);
  if (auth === null) return null;
  const capabilities = resolveFinalPluginAcpCapabilities(definition);

  return {
    backendId,
    name,
    title,
    description: readOptionalString(definition.ux.description),
    command: launch.kind === 'executable' ? launch.command : launch.agentId,
    args: [...launch.args],
    launch,
    env,
    ...(auth ? { auth } : {}),
    transportProfile: DEFAULT_ACP_TRANSPORT_PROFILE,
    capabilities,
    defaultMode: readOptionalString(definition.ux.defaultMode),
    defaultModel: readOptionalString(definition.ux.defaultModel),
    ...(definition.timeouts ? { timeouts: definition.timeouts } : {}),
    ...(typeof definition.fsEnabled === 'boolean' ? { fsEnabled: definition.fsEnabled } : {}),
    ...(definition.transportLifecycle ? { transportLifecycle: definition.transportLifecycle } : {}),
    ...(definition.permissionModeArgv ? { permissionModeArgv: definition.permissionModeArgv } : {}),
    ...(definition.sessionIdHeaderName ? { sessionIdHeaderName: definition.sessionIdHeaderName } : {}),
    ...(definition.bootstrap ? { bootstrap: definition.bootstrap } : {}),
    ...(definition.messageMeta ? { messageMeta: definition.messageMeta } : {}),
    ...(definition.mcp ? { mcp: definition.mcp } : {}),
  };
}

export function resolveConfiguredAcpBackendFromPluginBackendDefinition(
  backendDefinition: Readonly<Record<string, unknown>> | null,
  backendId: string,
  pluginId?: string,
): ResolvedConfiguredAcpBackend | null {
  if (!backendDefinition) return null;
  const backendDefinitionRecord = asRecord(backendDefinition);
  if (!backendDefinitionRecord) return null;
  const finalDefinition = resolveFinalPluginAcpBackendDefinition(backendDefinitionRecord, backendId, pluginId);
  if (finalDefinition) return finalDefinition;
  return null;
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
    if (backendContribution.provenance !== 'external' || !backendContribution.pluginId) continue;
    const plugin = loadedPluginsById.get(backendContribution.pluginId);
    if (!plugin) continue;
    const rawBackend = plugin.manifest.contributes.backends.find((entry) => entry.id === backendContribution.id) ?? null;
    const backend = resolveConfiguredAcpBackendFromPluginBackendDefinition(rawBackend, backendContribution.id, backendContribution.pluginId);
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
