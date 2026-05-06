import type {
  ActionDefinitionV1,
  PluginActionContributionV2,
  PluginCommandContributionV2,
  PluginExecutionRunProfileContributionV2,
  PluginHookContributionV2,
  PluginLifecycleHandlerContributionV2,
  PluginMcpBackendClientContributionV1,
  PluginMcpDiscoveryProviderContributionV1,
  PluginMcpServerContributionV1,
  PluginMcpToolContributionV1,
  PluginNotificationCategoryContributionV2,
  PluginNotificationChannelContributionV2,
  PluginResourceContributionV2,
  PluginSettingsContributionV2,
  ScmHostingProviderContribution,
  PluginSourceSpecV1,
  PluginToolContributionV2,
  PluginUiDescriptorContributionV2,
  HookRegistrationV1,
  InstallableDependencyDescriptor,
  ProviderDefinitionV1,
} from '@happier-dev/protocol';

import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import type { CanonicalPluginBackendDefinition } from '@/plugins/manifest/types';
import { resolvePluginResourcePath } from '@/plugins/projection/resources/package/resolve';
import type {
  ResolvedCommandDefinition,
  ResolvedLifecycleHandlerDefinition,
  ResolvedResourceDefinition,
  ResolvedToolDefinition,
  ResolvedUiDescriptorDefinition,
} from '../types';

export type PluginOwnedContribution<T> = Readonly<{
  pluginId: string;
  pluginRootPath: string;
  manifestPath: string;
  manifestDigest: string;
  daemonEntryPath: string | null;
  sourceSpec: PluginSourceSpecV1;
  definition: T;
}>;

export type PluginContributionRegistry = Readonly<{
  providers: readonly PluginOwnedContribution<ProviderDefinitionV1>[];
  backends: readonly PluginOwnedContribution<CanonicalPluginBackendDefinition>[];
  actions: readonly PluginOwnedContribution<ActionDefinitionV1>[];
  tools: readonly PluginOwnedContribution<ResolvedToolDefinition>[];
  commands: readonly PluginOwnedContribution<ResolvedCommandDefinition>[];
  hooks: readonly PluginOwnedContribution<HookRegistrationV1>[];
  resources: readonly PluginOwnedContribution<ResolvedResourceDefinition>[];
  uiDescriptors: readonly PluginOwnedContribution<ResolvedUiDescriptorDefinition>[];
  settings: readonly PluginOwnedContribution<PluginSettingsContributionV2>[];
  notifications: readonly PluginOwnedContribution<PluginNotificationCategoryContributionV2>[];
  notificationChannels: readonly PluginOwnedContribution<PluginNotificationChannelContributionV2>[];
  executionRunProfiles: readonly PluginOwnedContribution<PluginExecutionRunProfileContributionV2>[];
  mcpServers: readonly PluginOwnedContribution<PluginMcpServerContributionV1>[];
  mcpBackendClients: readonly PluginOwnedContribution<PluginMcpBackendClientContributionV1>[];
  mcpTools: readonly PluginOwnedContribution<PluginMcpToolContributionV1>[];
  mcpDiscoveryProviders: readonly PluginOwnedContribution<PluginMcpDiscoveryProviderContributionV1>[];
  scmHostingProviders: readonly PluginOwnedContribution<ScmHostingProviderContribution>[];
  installables: readonly PluginOwnedContribution<InstallableDependencyDescriptor>[];
  lifecycleHandlers: readonly PluginOwnedContribution<ResolvedLifecycleHandlerDefinition>[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readContributionArray<T>(contributes: unknown, key: string): readonly T[] {
  if (!isRecord(contributes)) {
    return [];
  }
  const value = contributes[key];
  return Array.isArray(value) ? value as readonly T[] : [];
}

function toActionDefinition(definition: PluginActionContributionV2): ActionDefinitionV1 {
  return Object.freeze({
    kindVersion: 1,
    id: definition.id,
    title: definition.title,
    description: definition.description ?? null,
    safety: definition.dangerLevel === 'safe' ? 'safe' : 'danger',
    placements: [],
    slash: null,
    bindings: null,
    examples: null,
    surfaces: {
      ui: definition.surfaces.some((surface) => (
        surface === 'settings'
        || surface === 'backendSettings'
        || surface === 'sessionMenu'
        || surface === 'executionRunMenu'
      )),
      voice: false,
      session_agent: definition.surfaces.includes('agentTool'),
      mcp: false,
      cli: definition.surfaces.includes('cli'),
      rpc: false,
      sdk: false,
    },
    inputHints: null,
    inputSchema: definition.inputSchema ?? {},
    ...(definition.resultSchema ? { outputSchema: definition.resultSchema } : {}),
    execution: {
      routing: 'daemon',
      handler: definition.handler,
    },
  });
}

function toToolDefinition(definition: PluginToolContributionV2): ResolvedToolDefinition {
  return Object.freeze({
    kindVersion: 1,
    id: definition.id,
    name: definition.name,
    title: definition.title,
    description: definition.description,
    safety: definition.safety,
    surfaces: {
      cli: definition.surfaces.cli,
      mcp: definition.surfaces.mcp,
      session_agent: definition.surfaces.session_agent,
    },
    inputSchema: definition.inputSchema ?? {},
    ...(definition.outputSchema ? { outputSchema: definition.outputSchema } : {}),
    ...(definition.inputHints ? { inputHints: definition.inputHints } : {}),
    ...(definition.compatibility ? { compatibility: definition.compatibility } : {}),
    ...(definition.examples ? { examples: definition.examples } : {}),
    actionId: definition.id,
  });
}

function toCommandDefinition(definition: PluginCommandContributionV2): ResolvedCommandDefinition {
  return Object.freeze({
    kindVersion: 1,
    id: definition.id,
    command: definition.command,
    ...(definition.rootHelpLabel ? { rootHelpLabel: definition.rootHelpLabel } : {}),
    ...(definition.rootHelpDescription ? { rootHelpDescription: definition.rootHelpDescription } : {}),
    ...(definition.rootHelpDetail ? { rootHelpDetail: definition.rootHelpDetail } : {}),
    allowTmux: definition.allowTmux,
    ...(definition.visibility ? { visibility: definition.visibility } : {}),
    ...(definition.featureGate ? { featureGate: definition.featureGate } : {}),
    actionId: definition.id,
  });
}

function toHookRegistration(definition: PluginHookContributionV2): HookRegistrationV1 {
  return Object.freeze({
    hookApiVersion: definition.hookApiVersion,
    id: definition.id,
    category: definition.category,
    scope: definition.scope,
    ...(definition.filters ? { filters: definition.filters } : {}),
    executionKind: definition.executionKind,
    handler: definition.handler,
    ...(typeof definition.priority === 'number' ? { priority: definition.priority } : {}),
    ...(definition.compatibility ? { compatibility: definition.compatibility } : {}),
  });
}

function toResourceDefinition(definition: PluginResourceContributionV2): ResolvedResourceDefinition {
  return Object.freeze({
    kindVersion: 1,
    id: definition.id,
    type: definition.resourceKind,
    path: definition.path,
    ...(definition.digest ? { digest: definition.digest } : {}),
    ...(definition.contentType ? { contentType: definition.contentType } : {}),
  });
}

function toUiDescriptorDefinition(definition: PluginUiDescriptorContributionV2): ResolvedUiDescriptorDefinition {
  return Object.freeze({
    kindVersion: 1,
    id: definition.id,
    surface: definition.surface,
    title: definition.title,
    description: definition.description,
    ...(typeof definition.order === 'number' ? { order: definition.order } : {}),
    ...(definition.tone ? { tone: definition.tone } : {}),
    ...(definition.featureGate !== undefined ? { featureGate: definition.featureGate } : {}),
    ...(definition.helpUrl !== undefined ? { helpUrl: definition.helpUrl } : {}),
    fields: Object.freeze(definition.fields.map((field) => Object.freeze({
      id: field.id,
      kind: field.type,
      title: field.title,
      description: field.description,
      ...(typeof field.order === 'number' ? { order: field.order } : {}),
      ...(field.groupId !== undefined ? { groupId: field.groupId } : {}),
      ...(field.featureGate !== undefined ? { featureGate: field.featureGate } : {}),
      ...(field.actionId !== undefined ? { actionId: field.actionId } : {}),
      options: Object.freeze((field.options ?? []).map((option) => Object.freeze({
        value: option.value,
        label: option.label,
      }))),
    }))),
  });
}

function toLifecycleHandlerDefinition(
  pluginId: string,
  index: number,
  definition: PluginLifecycleHandlerContributionV2,
): ResolvedLifecycleHandlerDefinition {
  const normalizedId = typeof definition.id === 'string' && definition.id.trim().length > 0
    ? definition.id.trim()
    : `${pluginId}:${definition.event}:${index}`;
  return Object.freeze({
    kindVersion: 1,
    id: normalizedId,
    event: definition.event,
    priority: definition.priority ?? 0,
  });
}

export function buildPluginContributionRegistry(params: Readonly<{
  loadedPlugins: readonly LoadedPlugin[];
}>): PluginContributionRegistry {
  const providers: PluginOwnedContribution<ProviderDefinitionV1>[] = [];
  const backends: PluginOwnedContribution<CanonicalPluginBackendDefinition>[] = [];
  const actions: PluginOwnedContribution<ActionDefinitionV1>[] = [];
  const tools: PluginOwnedContribution<ResolvedToolDefinition>[] = [];
  const commands: PluginOwnedContribution<ResolvedCommandDefinition>[] = [];
  const hooks: PluginOwnedContribution<HookRegistrationV1>[] = [];
  const resources: PluginOwnedContribution<ResolvedResourceDefinition>[] = [];
  const uiDescriptors: PluginOwnedContribution<ResolvedUiDescriptorDefinition>[] = [];
  const settings: PluginOwnedContribution<PluginSettingsContributionV2>[] = [];
  const notifications: PluginOwnedContribution<PluginNotificationCategoryContributionV2>[] = [];
  const notificationChannels: PluginOwnedContribution<PluginNotificationChannelContributionV2>[] = [];
  const executionRunProfiles: PluginOwnedContribution<PluginExecutionRunProfileContributionV2>[] = [];
  const mcpServers: PluginOwnedContribution<PluginMcpServerContributionV1>[] = [];
  const mcpBackendClients: PluginOwnedContribution<PluginMcpBackendClientContributionV1>[] = [];
  const mcpTools: PluginOwnedContribution<PluginMcpToolContributionV1>[] = [];
  const mcpDiscoveryProviders: PluginOwnedContribution<PluginMcpDiscoveryProviderContributionV1>[] = [];
  const scmHostingProviders: PluginOwnedContribution<ScmHostingProviderContribution>[] = [];
  const installables: PluginOwnedContribution<InstallableDependencyDescriptor>[] = [];
  const lifecycleHandlers: PluginOwnedContribution<ResolvedLifecycleHandlerDefinition>[] = [];

  for (const plugin of params.loadedPlugins) {
    for (const definition of plugin.manifest.contributes.providers) {
      providers.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        manifestDigest: plugin.manifestDigest,
        daemonEntryPath: plugin.daemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of plugin.manifest.contributes.backends) {
      backends.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        manifestDigest: plugin.manifestDigest,
        daemonEntryPath: plugin.daemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readContributionArray<PluginActionContributionV2>(plugin.manifest.contributes, 'actions')) {
      actions.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        manifestDigest: plugin.manifestDigest,
        daemonEntryPath: plugin.daemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition: toActionDefinition(definition),
      });
    }

    for (const definition of readContributionArray<PluginToolContributionV2>(plugin.manifest.contributes, 'tools')) {
      tools.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        manifestDigest: plugin.manifestDigest,
        daemonEntryPath: plugin.daemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition: toToolDefinition(definition),
      });
    }

    for (const definition of readContributionArray<PluginCommandContributionV2>(plugin.manifest.contributes, 'commands')) {
      commands.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        manifestDigest: plugin.manifestDigest,
        daemonEntryPath: plugin.daemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition: toCommandDefinition(definition),
      });
    }

    for (const definition of readContributionArray<PluginHookContributionV2>(plugin.manifest.contributes, 'hooks')) {
      hooks.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        manifestDigest: plugin.manifestDigest,
        daemonEntryPath: plugin.daemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition: toHookRegistration(definition),
      });
    }

    for (const definition of readContributionArray<PluginResourceContributionV2>(plugin.manifest.contributes, 'resources')) {
      const normalized = toResourceDefinition(definition);
      const resourcePath = normalized.path;
      if (resourcePath) {
        const resolvedPath = resolvePluginResourcePath({
          pluginRootPath: plugin.pluginRootPath,
          resourcePath,
        });
        if (!resolvedPath) {
          continue;
        }
        resources.push({
          pluginId: plugin.pluginId,
          pluginRootPath: plugin.pluginRootPath,
          manifestPath: plugin.manifestPath,
          manifestDigest: plugin.manifestDigest,
          daemonEntryPath: plugin.daemonEntryPath,
          sourceSpec: plugin.sourceSpec,
          definition: Object.freeze({
            ...normalized,
            path: resolvedPath.relativePath,
          }),
        });
        continue;
      }
      resources.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        manifestDigest: plugin.manifestDigest,
        daemonEntryPath: plugin.daemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition: normalized,
      });
    }

    for (const definition of readContributionArray<PluginUiDescriptorContributionV2>(plugin.manifest.contributes, 'uiDescriptors')) {
      const normalized = toUiDescriptorDefinition(definition);
      uiDescriptors.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        manifestDigest: plugin.manifestDigest,
        daemonEntryPath: plugin.daemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition: normalized,
      });
    }

    for (const definition of readContributionArray<PluginSettingsContributionV2>(plugin.manifest.contributes, 'settings')) {
      settings.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        manifestDigest: plugin.manifestDigest,
        daemonEntryPath: plugin.daemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readContributionArray<PluginNotificationCategoryContributionV2>(plugin.manifest.contributes, 'notifications')) {
      notifications.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        manifestDigest: plugin.manifestDigest,
        daemonEntryPath: plugin.daemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readContributionArray<PluginNotificationChannelContributionV2>(plugin.manifest.contributes, 'notificationChannels')) {
      notificationChannels.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        manifestDigest: plugin.manifestDigest,
        daemonEntryPath: plugin.daemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readContributionArray<PluginExecutionRunProfileContributionV2>(plugin.manifest.contributes, 'executionRunProfiles')) {
      executionRunProfiles.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        manifestDigest: plugin.manifestDigest,
        daemonEntryPath: plugin.daemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    const mcp = isRecord(plugin.manifest.contributes.mcp) ? plugin.manifest.contributes.mcp : {};
    for (const definition of readContributionArray<PluginMcpServerContributionV1>(mcp, 'servers')) {
      mcpServers.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        manifestDigest: plugin.manifestDigest,
        daemonEntryPath: plugin.daemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readContributionArray<PluginMcpBackendClientContributionV1>(mcp, 'backendClients')) {
      mcpBackendClients.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        manifestDigest: plugin.manifestDigest,
        daemonEntryPath: plugin.daemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readContributionArray<PluginMcpToolContributionV1>(mcp, 'tools')) {
      mcpTools.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        manifestDigest: plugin.manifestDigest,
        daemonEntryPath: plugin.daemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readContributionArray<PluginMcpDiscoveryProviderContributionV1>(mcp, 'discoveryProviders')) {
      mcpDiscoveryProviders.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        manifestDigest: plugin.manifestDigest,
        daemonEntryPath: plugin.daemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readContributionArray<ScmHostingProviderContribution>(plugin.manifest.contributes, 'scmHostingProviders')) {
      scmHostingProviders.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        manifestDigest: plugin.manifestDigest,
        daemonEntryPath: plugin.daemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readContributionArray<InstallableDependencyDescriptor>(plugin.manifest.contributes, 'installables')) {
      installables.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        manifestDigest: plugin.manifestDigest,
        daemonEntryPath: plugin.daemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const [index, definition] of readContributionArray<PluginLifecycleHandlerContributionV2>(
      plugin.manifest.contributes,
      'lifecycleHandlers',
    ).entries()) {
      lifecycleHandlers.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        manifestDigest: plugin.manifestDigest,
        daemonEntryPath: plugin.daemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition: toLifecycleHandlerDefinition(plugin.pluginId, index, definition),
      });
    }
  }

  return Object.freeze({
    providers: Object.freeze(providers),
    backends: Object.freeze(backends),
    actions: Object.freeze(actions),
    tools: Object.freeze(tools),
    commands: Object.freeze(commands),
    hooks: Object.freeze(hooks),
    resources: Object.freeze(resources),
    uiDescriptors: Object.freeze(uiDescriptors),
    settings: Object.freeze(settings),
    notifications: Object.freeze(notifications),
    notificationChannels: Object.freeze(notificationChannels),
    executionRunProfiles: Object.freeze(executionRunProfiles),
    mcpServers: Object.freeze(mcpServers),
    mcpBackendClients: Object.freeze(mcpBackendClients),
    mcpTools: Object.freeze(mcpTools),
    mcpDiscoveryProviders: Object.freeze(mcpDiscoveryProviders),
    scmHostingProviders: Object.freeze(scmHostingProviders),
    installables: Object.freeze(installables),
    lifecycleHandlers: Object.freeze(lifecycleHandlers),
  });
}
