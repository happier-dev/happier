import type {
  ActionDefinitionV1,
  PluginActionContributionV2,
  PluginCommandContributionV2,
  PluginExecutionRunProfileContributionV2,
  PluginEventContributionV1,
  PluginHookContributionV2,
  PluginHostedWebContributionV1,
  PluginLifecycleHandlerContributionV2,
  PluginMcpDiscoveryProviderContributionV1,
  PluginMcpServerContributionV1,
  PluginNotificationCategoryContributionV2,
  PluginNotificationChannelContributionV2,
  PluginReactNativeBundleContributionV1,
  PluginRequestInterceptorContributionV1,
  PluginResourceContributionV2,
  PluginSessionHeaderActionDescriptorV1,
  PluginSessionSurfaceDescriptorV1,
  PluginSettingsContributionV2,
  PluginStructuredMessageDescriptorV1,
  PluginUiArtifactContributionV1,
  ScmHostingProviderContribution,
  PluginConnectedAccountDescriptorContributionV2,
  PluginSourceSpecV1,
  PluginToolContributionV2,
  PluginUiDescriptorContributionV2,
  PluginUiTranslationsContributionV1,
  HookRegistrationV1,
  InstallableDependencyDescriptor,
  ScmBackendContribution,
  ProviderDefinitionV1,
} from '@happier-dev/protocol';
import { createPluginContributionIdentity, qualifyPluginEventIdV1 } from '@happier-dev/protocol';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol';

import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import type { CanonicalPluginBackendDefinition } from '@/plugins/manifest/types';
import { resolvePluginResourcePath } from '@/plugins/projection/resources/package/resolve';
import type {
  ResolvedCommandDefinition,
  ResolvedEventDefinition,
  ResolvedLifecycleHandlerDefinition,
  ResolvedResourceDefinition,
  ResolvedToolDefinition,
  ResolvedUiDescriptorDefinition,
} from '../types';

export type PluginOwnedContribution<T> = Readonly<{
  pluginId: string;
  identity?: PluginContributionIdentityV1;
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
  uiTranslations: readonly PluginOwnedContribution<PluginUiTranslationsContributionV1>[];
  structuredMessages: readonly PluginOwnedContribution<PluginStructuredMessageDescriptorV1>[];
  sessionSurfaces: readonly PluginOwnedContribution<PluginSessionSurfaceDescriptorV1>[];
  sessionHeaderActions: readonly PluginOwnedContribution<PluginSessionHeaderActionDescriptorV1>[];
  hostedWeb: readonly PluginOwnedContribution<PluginHostedWebContributionV1>[];
  reactNativeBundles: readonly PluginOwnedContribution<PluginReactNativeBundleContributionV1>[];
  uiArtifacts: readonly PluginOwnedContribution<PluginUiArtifactContributionV1>[];
  settings: readonly PluginOwnedContribution<PluginSettingsContributionV2>[];
  notifications: readonly PluginOwnedContribution<PluginNotificationCategoryContributionV2>[];
  notificationChannels: readonly PluginOwnedContribution<PluginNotificationChannelContributionV2>[];
  events: readonly PluginOwnedContribution<ResolvedEventDefinition>[];
  executionRunProfiles: readonly PluginOwnedContribution<PluginExecutionRunProfileContributionV2>[];
  mcpServers: readonly PluginOwnedContribution<PluginMcpServerContributionV1>[];
  mcpDiscoveryProviders: readonly PluginOwnedContribution<PluginMcpDiscoveryProviderContributionV1>[];
  scmHostingProviders: readonly PluginOwnedContribution<ScmHostingProviderContribution>[];
  scmBackends: readonly PluginOwnedContribution<ScmBackendContribution>[];
  connectedAccountDescriptors: readonly PluginOwnedContribution<PluginConnectedAccountDescriptorContributionV2>[];
  installables: readonly PluginOwnedContribution<InstallableDependencyDescriptor>[];
  requestInterceptors: readonly PluginOwnedContribution<PluginRequestInterceptorContributionV1>[];
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

function toEventDefinition(pluginId: string, definition: PluginEventContributionV1): ResolvedEventDefinition {
  return Object.freeze({
    ...definition,
    id: qualifyPluginEventIdV1(pluginId, definition.id),
    localId: definition.id,
    deprecated: definition.deprecated ?? false,
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
  const uiTranslations: PluginOwnedContribution<PluginUiTranslationsContributionV1>[] = [];
  const structuredMessages: PluginOwnedContribution<PluginStructuredMessageDescriptorV1>[] = [];
  const sessionSurfaces: PluginOwnedContribution<PluginSessionSurfaceDescriptorV1>[] = [];
  const sessionHeaderActions: PluginOwnedContribution<PluginSessionHeaderActionDescriptorV1>[] = [];
  const hostedWeb: PluginOwnedContribution<PluginHostedWebContributionV1>[] = [];
  const reactNativeBundles: PluginOwnedContribution<PluginReactNativeBundleContributionV1>[] = [];
  const uiArtifacts: PluginOwnedContribution<PluginUiArtifactContributionV1>[] = [];
  const settings: PluginOwnedContribution<PluginSettingsContributionV2>[] = [];
  const notifications: PluginOwnedContribution<PluginNotificationCategoryContributionV2>[] = [];
  const notificationChannels: PluginOwnedContribution<PluginNotificationChannelContributionV2>[] = [];
  const events: PluginOwnedContribution<ResolvedEventDefinition>[] = [];
  const executionRunProfiles: PluginOwnedContribution<PluginExecutionRunProfileContributionV2>[] = [];
  const mcpServers: PluginOwnedContribution<PluginMcpServerContributionV1>[] = [];
  const mcpDiscoveryProviders: PluginOwnedContribution<PluginMcpDiscoveryProviderContributionV1>[] = [];
  const scmHostingProviders: PluginOwnedContribution<ScmHostingProviderContribution>[] = [];
  const scmBackends: PluginOwnedContribution<ScmBackendContribution>[] = [];
  const connectedAccountDescriptors: PluginOwnedContribution<PluginConnectedAccountDescriptorContributionV2>[] = [];
  const installables: PluginOwnedContribution<InstallableDependencyDescriptor>[] = [];
  const requestInterceptors: PluginOwnedContribution<PluginRequestInterceptorContributionV1>[] = [];
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

    for (const definition of readContributionArray<PluginUiTranslationsContributionV1>(plugin.manifest.contributes, 'uiTranslations')) {
      uiTranslations.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        manifestDigest: plugin.manifestDigest,
        daemonEntryPath: plugin.daemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readContributionArray<PluginStructuredMessageDescriptorV1>(plugin.manifest.contributes, 'structuredMessages')) {
      structuredMessages.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        manifestDigest: plugin.manifestDigest,
        daemonEntryPath: plugin.daemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readContributionArray<PluginSessionSurfaceDescriptorV1>(plugin.manifest.contributes, 'sessionSurfaces')) {
      sessionSurfaces.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        manifestDigest: plugin.manifestDigest,
        daemonEntryPath: plugin.daemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readContributionArray<PluginSessionHeaderActionDescriptorV1>(plugin.manifest.contributes, 'sessionHeaderActions')) {
      sessionHeaderActions.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        manifestDigest: plugin.manifestDigest,
        daemonEntryPath: plugin.daemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readContributionArray<PluginHostedWebContributionV1>(plugin.manifest.contributes, 'hostedWeb')) {
      hostedWeb.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        manifestDigest: plugin.manifestDigest,
        daemonEntryPath: plugin.daemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readContributionArray<PluginReactNativeBundleContributionV1>(plugin.manifest.contributes, 'reactNativeBundles')) {
      reactNativeBundles.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        manifestDigest: plugin.manifestDigest,
        daemonEntryPath: plugin.daemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readContributionArray<PluginUiArtifactContributionV1>(plugin.manifest.contributes, 'uiArtifacts')) {
      uiArtifacts.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        manifestDigest: plugin.manifestDigest,
        daemonEntryPath: plugin.daemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
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

    for (const definition of readContributionArray<PluginEventContributionV1>(plugin.manifest.contributes, 'events')) {
      events.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        manifestDigest: plugin.manifestDigest,
        daemonEntryPath: plugin.daemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition: toEventDefinition(plugin.pluginId, definition),
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
        identity: createPluginContributionIdentity({
          pluginId: plugin.pluginId,
          family: 'scmHostingProviders',
          contributionId: definition.id,
          provenance: 'external',
        }),
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        manifestDigest: plugin.manifestDigest,
        daemonEntryPath: plugin.daemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readContributionArray<ScmBackendContribution>(plugin.manifest.contributes, 'scmBackends')) {
      scmBackends.push({
        pluginId: plugin.pluginId,
        identity: createPluginContributionIdentity({
          pluginId: plugin.pluginId,
          family: 'scmBackends',
          contributionId: definition.id,
          provenance: 'external',
        }),
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        manifestDigest: plugin.manifestDigest,
        daemonEntryPath: plugin.daemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readContributionArray<PluginConnectedAccountDescriptorContributionV2>(plugin.manifest.contributes, 'connectedAccountDescriptors')) {
      connectedAccountDescriptors.push({
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

    for (const definition of readContributionArray<PluginRequestInterceptorContributionV1>(plugin.manifest.contributes, 'requestInterceptors')) {
      requestInterceptors.push({
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
    uiTranslations: Object.freeze(uiTranslations),
    structuredMessages: Object.freeze(structuredMessages),
    sessionSurfaces: Object.freeze(sessionSurfaces),
    sessionHeaderActions: Object.freeze(sessionHeaderActions),
    hostedWeb: Object.freeze(hostedWeb),
    reactNativeBundles: Object.freeze(reactNativeBundles),
    uiArtifacts: Object.freeze(uiArtifacts),
    settings: Object.freeze(settings),
    notifications: Object.freeze(notifications),
    notificationChannels: Object.freeze(notificationChannels),
    events: Object.freeze(events),
    executionRunProfiles: Object.freeze(executionRunProfiles),
    mcpServers: Object.freeze(mcpServers),
    mcpDiscoveryProviders: Object.freeze(mcpDiscoveryProviders),
    scmHostingProviders: Object.freeze(scmHostingProviders),
    scmBackends: Object.freeze(scmBackends),
    connectedAccountDescriptors: Object.freeze(connectedAccountDescriptors),
    installables: Object.freeze(installables),
    requestInterceptors: Object.freeze(requestInterceptors),
    lifecycleHandlers: Object.freeze(lifecycleHandlers),
  });
}
