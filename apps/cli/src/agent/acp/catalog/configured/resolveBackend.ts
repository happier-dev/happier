import {
  AcpBackendCapabilitiesV1Schema,
  AcpCatalogTransportProfileV1Schema,
} from '@happier-dev/protocol';
import type {
  AcpBackendAuthConfigV1,
  AcpBackendCapabilitiesV1,
  AcpCatalogTransportProfileV1,
  McpValueRefV1,
  PluginSystemToolContributionV1,
} from '@happier-dev/protocol';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';

import { readAcpCatalogSettingsFromAccountSettings } from '../readAcpCatalogSettingsFromAccountSettings';
import { normalizePluginBackendContributionAcpDefinition } from '../../runtime/definition/plugin';
import type {
  AcpRuntimeDefinition,
  HostAcpMcpInputPolicy,
  HostAcpMessageMetaHooks,
  HostAcpPermissionModeArgvSpec,
  HostAcpStderrRules,
  HostAcpTimeouts,
  HostAcpTransportLifecycle,
} from '../../runtime/definition/_types';

export type ResolvedConfiguredAcpBackend = Readonly<{
  backendId: string;
  source: Readonly<
    | { kind: 'account_configured' }
    | {
        kind: 'plugin_contributed';
        pluginId: string;
        systemTools: readonly PluginSystemToolContributionV1[];
      }
  >;
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
        kind: 'system-tool';
        toolId: string;
        purpose: string;
        args: ReadonlyArray<string>;
        env?: Readonly<Record<string, string>>;
      }
  >;
  env: Readonly<Record<string, McpValueRefV1>>;
  auth?: AcpBackendAuthConfigV1;
  transportProfile: AcpCatalogTransportProfileV1;
  capabilities: AcpBackendCapabilitiesV1;
  defaultMode?: string;
  defaultModel?: string;
  timeouts?: HostAcpTimeouts;
  fsEnabled?: boolean;
  transportLifecycle?: HostAcpTransportLifecycle;
  permissionModeArgv?: HostAcpPermissionModeArgvSpec;
  sessionIdHeaderName?: string;
  messageMeta?: HostAcpMessageMetaHooks;
  stderrRules?: HostAcpStderrRules;
  mcp?: HostAcpMcpInputPolicy;
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
    source: { kind: 'account_configured' },
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

function resolvePluginAcpCapabilities(
  definition: AcpRuntimeDefinition,
): AcpBackendCapabilitiesV1 {
  return {
    ...DEFAULT_ACP_CAPABILITIES,
    supportsLoadSession: definition.capabilities.supportsResume === true,
  };
}

function resolveFinalPluginAcpLaunch(
  definition: AcpRuntimeDefinition,
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

  if (transport.launch.kind !== 'system-tool') return null;
  const toolId = readOptionalString(transport.launch.toolId);
  if (!toolId) return null;
  return {
    kind: 'system-tool',
    toolId,
    purpose: transport.launch.purpose,
    args: [...(transport.launch.args ?? [])],
    ...(transport.launch.env ? { env: { ...transport.launch.env } } : {}),
  };
}

function resolveFinalPluginAcpBackendDefinition(
  backendDefinitionRecord: Readonly<Record<string, unknown>>,
  backendId: string,
  pluginId?: string,
  systemTools: readonly PluginSystemToolContributionV1[] = [],
): ResolvedConfiguredAcpBackend | null {
  let definition: AcpRuntimeDefinition;
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
  const env = parseLaunchLiteralEnv(transport.launch.env ?? {});
  if (!env) return null;

  const title = readOptionalString(definition.ux.title) ?? backendId;
  const name = readOptionalString(definition.ux.name) ?? backendId;
  const capabilities = resolvePluginAcpCapabilities(definition);

  return {
    backendId,
    source: pluginId
      ? {
          kind: 'plugin_contributed',
          pluginId,
          systemTools: Object.freeze(systemTools.map((definition) => Object.freeze({ ...definition }))),
        }
      : { kind: 'account_configured' },
    name,
    title,
    description: readOptionalString(definition.ux.description),
    command: launch.kind === 'executable' ? launch.command : launch.toolId,
    args: [...launch.args],
    launch,
    env,
    transportProfile: DEFAULT_ACP_TRANSPORT_PROFILE,
    capabilities,
    ...(definition.timeouts ? { timeouts: definition.timeouts } : {}),
    ...(definition.stderrRules ? { stderrRules: definition.stderrRules } : {}),
    mcp: definition.mcp,
  };
}

export function resolveConfiguredAcpBackendFromPluginBackendDefinition(
  backendDefinition: Readonly<Record<string, unknown>> | null,
  backendId: string,
  pluginId?: string,
  systemTools: readonly PluginSystemToolContributionV1[] = [],
): ResolvedConfiguredAcpBackend | null {
  if (!backendDefinition) return null;
  const backendDefinitionRecord = asRecord(backendDefinition);
  if (!backendDefinitionRecord) return null;
  const finalDefinition = resolveFinalPluginAcpBackendDefinition(
    backendDefinitionRecord,
    backendId,
    pluginId,
    systemTools,
  );
  if (finalDefinition) return finalDefinition;
  return null;
}

async function listPluginConfiguredAcpBackends(params: Readonly<{
  happyHomeDir?: string;
}>): Promise<ReadonlyArray<ResolvedConfiguredAcpBackend>> {
  const mergedRegistry = await resolveMergedContributionRegistry({ happyHomeDir: params.happyHomeDir });
  return listPluginConfiguredAcpBackendsFromRegistry(mergedRegistry);
}

export function listPluginConfiguredAcpBackendsFromRegistry(
  mergedRegistry: Pick<ResolvedContributionRegistry, 'agents' | 'systemTools'>,
): ReadonlyArray<ResolvedConfiguredAcpBackend> {
  const resolved: ResolvedConfiguredAcpBackend[] = [];
  for (const agentContribution of mergedRegistry.agents) {
    if (
      agentContribution.provenance !== 'external'
      || !agentContribution.pluginId
      || agentContribution.richDefinition?.provenance !== 'external'
    ) continue;
    const rawAgent = agentContribution.richDefinition.definition;
    const systemTools = (mergedRegistry.systemTools ?? [])
      .filter((tool) => tool.pluginId === agentContribution.pluginId)
      .map((tool) => tool.definition);
    const backend = resolveConfiguredAcpBackendFromPluginBackendDefinition(
      rawAgent,
      agentContribution.id,
      agentContribution.pluginId,
      systemTools,
    );
    if (backend) {
      resolved.push(backend);
    }
  }
  return Object.freeze(resolved);
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
