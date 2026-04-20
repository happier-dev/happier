import type {
  ActionDefinitionV1,
  BackendDefinitionV1,
  ExtensionActionContributionV2,
  ExtensionCommandContributionV2,
  ExtensionHookContributionV2,
  ExtensionLifecycleHandlerContributionV2,
  ExtensionResourceContributionV2,
  ExtensionSourceSpecV1,
  ExtensionToolContributionV2,
  ExtensionUiDescriptorContributionV2,
  HookRegistrationV1,
  ProviderDefinitionV1,
} from '@happier-dev/protocol';

import type { LoadedPlugin } from '../../load/installed';
import { resolvePluginResourcePath } from '../../resources/package/resolve';
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
  sourceSpec: ExtensionSourceSpecV1;
  definition: T;
}>;

export type PluginContributionRegistry = Readonly<{
  providers: readonly PluginOwnedContribution<ProviderDefinitionV1>[];
  backends: readonly PluginOwnedContribution<BackendDefinitionV1>[];
  actions: readonly PluginOwnedContribution<ActionDefinitionV1>[];
  tools: readonly PluginOwnedContribution<ResolvedToolDefinition>[];
  commands: readonly PluginOwnedContribution<ResolvedCommandDefinition>[];
  hooks: readonly PluginOwnedContribution<HookRegistrationV1>[];
  resources: readonly PluginOwnedContribution<ResolvedResourceDefinition>[];
  uiDescriptors: readonly PluginOwnedContribution<ResolvedUiDescriptorDefinition>[];
  lifecycleHandlers: readonly PluginOwnedContribution<ResolvedLifecycleHandlerDefinition>[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readContributionArray<T>(contributions: unknown, key: string): readonly T[] {
  if (!isRecord(contributions)) {
    return [];
  }
  const value = contributions[key];
  return Array.isArray(value) ? value as readonly T[] : [];
}

function isExtensionActionContribution(
  definition: ActionDefinitionV1 | ExtensionActionContributionV2,
): definition is ExtensionActionContributionV2 {
  return isRecord(definition) && definition.kind === 'action';
}

function isExtensionHookContribution(
  definition: HookRegistrationV1 | ExtensionHookContributionV2,
): definition is ExtensionHookContributionV2 {
  return isRecord(definition) && definition.kind === 'hook';
}

function toActionDefinition(definition: ExtensionActionContributionV2): ActionDefinitionV1 {
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
      ui_button: definition.surfaces.some((surface) => (
        surface === 'settings'
        || surface === 'providerSettings'
        || surface === 'backendSettings'
        || surface === 'sessionMenu'
        || surface === 'executionRunMenu'
      )),
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      session_agent: definition.surfaces.includes('agentTool'),
      mcp: false,
      cli: definition.surfaces.includes('cli'),
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

function toToolDefinition(definition: ExtensionToolContributionV2): ResolvedToolDefinition {
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

function toCommandDefinition(definition: ExtensionCommandContributionV2): ResolvedCommandDefinition {
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

function toHookRegistration(definition: ExtensionHookContributionV2): HookRegistrationV1 {
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

function toResourceDefinition(definition: ExtensionResourceContributionV2): ResolvedResourceDefinition {
  return Object.freeze({
    kindVersion: 1,
    id: definition.id,
    type: definition.resourceKind,
    path: definition.path,
    ...(definition.digest ? { digest: definition.digest } : {}),
    ...(definition.contentType ? { contentType: definition.contentType } : {}),
  });
}

function toUiDescriptorDefinition(definition: ExtensionUiDescriptorContributionV2): ResolvedUiDescriptorDefinition {
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
  definition: ExtensionLifecycleHandlerContributionV2,
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
  const backends: PluginOwnedContribution<BackendDefinitionV1>[] = [];
  const actions: PluginOwnedContribution<ActionDefinitionV1>[] = [];
  const tools: PluginOwnedContribution<ResolvedToolDefinition>[] = [];
  const commands: PluginOwnedContribution<ResolvedCommandDefinition>[] = [];
  const hooks: PluginOwnedContribution<HookRegistrationV1>[] = [];
  const resources: PluginOwnedContribution<ResolvedResourceDefinition>[] = [];
  const uiDescriptors: PluginOwnedContribution<ResolvedUiDescriptorDefinition>[] = [];
  const lifecycleHandlers: PluginOwnedContribution<ResolvedLifecycleHandlerDefinition>[] = [];

  for (const plugin of params.loadedPlugins) {
    for (const definition of plugin.manifest.contributions.providers) {
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

    for (const definition of plugin.manifest.contributions.backends) {
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

    for (const definition of readContributionArray<ActionDefinitionV1 | ExtensionActionContributionV2>(plugin.manifest.contributions, 'actions')) {
      actions.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        manifestDigest: plugin.manifestDigest,
        daemonEntryPath: plugin.daemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition: isExtensionActionContribution(definition)
          ? toActionDefinition(definition)
          : definition,
      });
    }

    for (const definition of readContributionArray<ExtensionToolContributionV2>(plugin.manifest.contributions, 'tools')) {
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

    for (const definition of readContributionArray<ExtensionCommandContributionV2>(plugin.manifest.contributions, 'commands')) {
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

    for (const definition of readContributionArray<HookRegistrationV1 | ExtensionHookContributionV2>(plugin.manifest.contributions, 'hooks')) {
      hooks.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        manifestDigest: plugin.manifestDigest,
        daemonEntryPath: plugin.daemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition: isExtensionHookContribution(definition)
          ? toHookRegistration(definition)
          : definition,
      });
    }

    for (const definition of readContributionArray<ExtensionResourceContributionV2>(plugin.manifest.contributions, 'resources')) {
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

    for (const definition of readContributionArray<ExtensionUiDescriptorContributionV2>(plugin.manifest.contributions, 'uiDescriptors')) {
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

    for (const [index, definition] of readContributionArray<ExtensionLifecycleHandlerContributionV2>(
      plugin.manifest.contributions,
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
    lifecycleHandlers: Object.freeze(lifecycleHandlers),
  });
}
