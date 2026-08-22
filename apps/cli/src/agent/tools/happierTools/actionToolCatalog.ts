import {
  isActionDirectToolExposedOn,
  listActionSpecs,
  resolveActionSurfaceAvailability,
  type ActionId,
  type ActionSurfaceAvailability,
  type ActionSurfaces,
  type ActionsSettingsV1,
} from '@happier-dev/protocol';

import { getResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type {
  ResolvedActionContribution,
  ResolvedContributionProvenance,
  ResolvedContributionRegistry,
} from '@/plugins/projection/registry/types';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import {
  projectExecutablePluginToolCatalog,
  type ProjectedPluginToolCatalogEntry,
} from '@/plugins/runtime/toolCatalog';
import type { HappierBuiltInToolDefinition } from './types';

type ActionEnabledPredicate = (id: ActionId) => boolean;
export type HappierBuiltInToolSurface = 'mcp' | 'cli' | 'agent';

type ActionToolEntry = Readonly<{
  id: string;
  toolId?: string;
  toolName: string;
  surfaces: Readonly<Record<HappierBuiltInToolSurface, boolean>>;
  title: string;
  description: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  safety?: 'safe' | 'danger';
  inputHints?: unknown;
  examples?: unknown;
  promptSnippet?: string;
  promptGuidelines?: readonly string[];
  availability?: unknown;
  provenance: ResolvedContributionProvenance;
}>;

type ActionToolCatalogAvailability = ActionSurfaceAvailability & Readonly<{
  provenance: ResolvedContributionProvenance | 'unknown';
}>;

const BUILT_IN_ACTION_TOOL_ENTRIES = Object.freeze(
  listActionSpecs()
    .map((spec) => ({
      id: String(spec.id),
      toolName: String(spec.bindings?.mcpToolName ?? '').trim(),
      surfaces: spec.surfaces,
      title: spec.title,
      description: spec.description ?? spec.title,
      inputSchema: spec.inputSchema,
      provenance: 'first_party' as const,
    }))
    .filter((entry) => entry.toolName.length > 0),
);
const BUILT_IN_ACTION_SPECS_BY_ID = new Map(
  listActionSpecs().map((spec) => [String(spec.id), spec] as const),
);

const MANUAL_TOOL_EQUIVALENT_ACTION_IDS = new Map<string, ActionId>([
  ['change_title', 'session.title.set'],
  ['action_spec_search', 'action.spec.search'],
  ['action_spec_get', 'action.spec.get'],
  ['action_options_resolve', 'action.options.resolve'],
]);
const DIRECT_MANUAL_TOOL_NAMES = new Set(['change_title']);

function resolveCurrentRuntimeRegistry() {
  const activeRegistry = pluginReloadController.getState().activeRegistry;
  return activeRegistry && pluginReloadController.isRuntimeRegistryCurrent(activeRegistry)
    ? activeRegistry
    : null;
}

function resolveActionToolRegistry(params?: Readonly<{
  registry?: ResolvedContributionRegistry;
}>): ResolvedContributionRegistry {
  const activeRegistry = resolveCurrentRuntimeRegistry()?.contributes;
  return params?.registry ?? activeRegistry ?? getResolvedContributionRegistry();
}

/**
 * A plugin-contributed Action is visible when the CURRENT runtime registry's
 * catalog policy says so. Provenance is not part of that decision: a bundled
 * first-party plugin contributes under `first_party` and reaches the agent
 * surface through the same declaration + policy path as an installed one, and
 * `projectExecutablePluginToolCatalog` — the tool-binding owner — applies no
 * provenance filter either. `pluginId` is what separates a plugin contribution
 * from a host built-in Action spec.
 */
function isAuthorizedPluginToolContribution(
  action: ResolvedActionContribution,
  registry: ResolvedContributionRegistry,
): boolean {
  if (!action.pluginId) return false;
  const activeRegistry = resolveCurrentRuntimeRegistry();
  if (!activeRegistry || activeRegistry.contributes !== registry) return false;
  return activeRegistry.targetActionInvocations?.evaluateCatalogPolicy(
    action.pluginId,
    action.definition.id,
  ).outcome === 'visible';
}

function toToolSurfaces(
  surfaces: readonly ('mcp' | 'cli' | 'agent')[],
): Readonly<Record<HappierBuiltInToolSurface, boolean>> {
  return Object.freeze({
    mcp: surfaces.includes('mcp'),
    cli: surfaces.includes('cli'),
    agent: surfaces.includes('agent'),
  });
}

function toPluginToolEntry(tool: ProjectedPluginToolCatalogEntry): ActionToolEntry {
  return {
    id: tool.actionId,
    toolId: tool.toolId,
    toolName: tool.name,
    surfaces: toToolSurfaces(tool.surfaces),
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
    safety: tool.safety,
    ...(tool.inputHints === undefined ? {} : { inputHints: tool.inputHints }),
    ...(tool.examples === undefined ? {} : { examples: tool.examples }),
    ...(tool.promptSnippet === undefined ? {} : { promptSnippet: tool.promptSnippet }),
    ...(tool.promptGuidelines === undefined ? {} : { promptGuidelines: tool.promptGuidelines }),
    ...(tool.availability === undefined ? {} : { availability: tool.availability }),
    provenance: 'external',
  };
}

function dedupeActionToolEntries(entries: readonly ActionToolEntry[]): readonly ActionToolEntry[] {
  const deduped = new Map<string, ActionToolEntry>();
  for (const entry of entries) {
    if (deduped.has(entry.toolName)) {
      continue;
    }
    deduped.set(entry.toolName, entry);
  }
  return Object.freeze([...deduped.values()]);
}

function listActionToolEntries(params?: Readonly<{
  registry?: ResolvedContributionRegistry;
  pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
}>): readonly ActionToolEntry[] {
  const activeRegistry = resolveCurrentRuntimeRegistry();
  const pluginToolCatalog = params?.pluginToolCatalog
    ?? (activeRegistry && (!params?.registry || activeRegistry.contributes === params.registry)
      ? projectExecutablePluginToolCatalog(activeRegistry)
      : []);
  const declaredToolEntries = pluginToolCatalog.map(toPluginToolEntry);

  return dedupeActionToolEntries([
    ...BUILT_IN_ACTION_TOOL_ENTRIES,
    ...declaredToolEntries,
  ]);
}

function getActionToolEntryById(actionId: string, params?: Readonly<{
  registry?: ResolvedContributionRegistry;
  pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
}>): ActionToolEntry | null {
  return listActionToolEntries(params).find((entry) => entry.id === actionId) ?? null;
}

function getPluginActionContributionById(
  actionId: string,
  params?: Readonly<{ registry?: ResolvedContributionRegistry }>,
): ResolvedActionContribution | null {
  return resolveActionToolRegistry(params).actionsById?.get(actionId) ?? null;
}

function getActionAvailableSurfaces(
  surfaces: Readonly<Record<HappierBuiltInToolSurface, boolean>> | Readonly<ActionSurfaces>,
): readonly (keyof ActionSurfaces)[] {
  return Object.entries(surfaces)
    .filter((entry): entry is [keyof ActionSurfaces, true] => entry[1] === true)
    .map(([surface]) => surface);
}

export function resolveActionToolCatalogAvailability(params: Readonly<{
  actionId: ActionId | string;
  surface?: HappierBuiltInToolSurface;
  isActionEnabled?: ActionEnabledPredicate;
  actionsSettings?: ActionsSettingsV1 | null;
  requireToolBinding?: boolean | null;
  registry?: ResolvedContributionRegistry;
  pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
}>): ActionToolCatalogAvailability {
  const surface = params.surface ?? 'agent';
  const actionId = String(params.actionId);
  const builtInSpec = BUILT_IN_ACTION_SPECS_BY_ID.get(actionId);
  if (builtInSpec) {
    return {
      ...resolveActionSurfaceAvailability({
        actionId: builtInSpec.id as ActionId,
        surface,
        settings: params.actionsSettings ?? null,
        isActionEnabled: params.isActionEnabled ?? null,
        requireToolBinding: params.requireToolBinding ?? null,
      }),
      provenance: 'first_party',
    };
  }

  const projectedTool = getActionToolEntryById(actionId, {
    registry: params.registry,
    pluginToolCatalog: params.pluginToolCatalog,
  });
  if (projectedTool) {
    const availableSurfaces = getActionAvailableSurfaces(projectedTool.surfaces);
    return projectedTool.surfaces[surface]
      ? {
          available: true,
          reason: 'available',
          actionId,
          surface,
          availableSurfaces,
          defaultToolExposureMode: 'direct',
          effectiveToolExposureMode: 'direct',
          provenance: 'external',
        }
      : {
          available: false,
          reason: 'unsupported_surface',
          actionId,
          surface,
          availableSurfaces,
          provenance: 'external',
      };
  }

  // An explicitly supplied catalog is a bounded admission snapshot (for
  // example, the active Agent-composition turn). It is authoritative for
  // external Actions, so an omitted plugin tool must not fall through to a
  // mutable global registry and bypass the admitted selection.
  if (params.pluginToolCatalog !== undefined) {
    return {
      available: false,
      reason: 'unknown_action',
      actionId,
      surface,
      availableSurfaces: [],
      provenance: 'unknown',
    };
  }

  const pluginAction = getPluginActionContributionById(actionId, { registry: params.registry });
  if (!pluginAction) {
    return {
      available: false,
      reason: 'unknown_action',
      actionId,
      surface,
      availableSurfaces: [],
      provenance: 'unknown',
    };
  }

  const availableSurfaces = getActionAvailableSurfaces(pluginAction.definition.surfaces);
  if (!isAuthorizedPluginToolContribution(
    pluginAction,
    resolveActionToolRegistry({ registry: params.registry }),
  )) {
    return {
      available: false,
      reason: 'unknown_action',
      actionId,
      surface,
      availableSurfaces,
      provenance: pluginAction.provenance,
    };
  }
  if (pluginAction.definition.surfaces[surface] !== true) {
    return {
      available: false,
      reason: 'unsupported_surface',
      actionId,
      surface,
      availableSurfaces,
      provenance: pluginAction.provenance,
    };
  }
  if (params.requireToolBinding && !getActionToolEntryById(actionId, {
    registry: params.registry,
    pluginToolCatalog: params.pluginToolCatalog,
  })) {
    return {
      available: false,
      reason: 'missing_tool_binding',
      actionId,
      surface,
      availableSurfaces,
      defaultToolExposureMode: 'direct',
      effectiveToolExposureMode: 'direct',
      provenance: pluginAction.provenance,
    };
  }

  return {
    available: true,
    reason: 'available',
    actionId,
    surface,
    availableSurfaces,
    defaultToolExposureMode: 'direct',
    effectiveToolExposureMode: 'direct',
    provenance: pluginAction.provenance,
  };
}

export function isActionKnownToToolCatalog(
  actionId: ActionId | string,
  params?: Readonly<{
    registry?: ResolvedContributionRegistry;
    pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
  }>,
): boolean {
  return getActionToolEntryById(String(actionId), params) !== null;
}

export function getActionToolIdForToolName(
  toolName: string,
  params?: Readonly<{
    registry?: ResolvedContributionRegistry;
    pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
  }>,
): string | null {
  return listActionToolEntries(params).find((entry) => entry.toolName === toolName)?.id ?? null;
}

export function getEquivalentActionIdForBuiltInTool(
  toolName: string,
  params?: Readonly<{
    registry?: ResolvedContributionRegistry;
    pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
  }>,
): string | null {
  return MANUAL_TOOL_EQUIVALENT_ACTION_IDS.get(toolName) ?? getActionToolIdForToolName(toolName, params);
}

export function listPluginActionBackedTools(params?: Readonly<{
  registry?: ResolvedContributionRegistry;
  pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
}>): readonly HappierBuiltInToolDefinition[] {
  return Object.freeze(
    listActionToolEntries(params)
      .filter((entry) => entry.provenance === 'external')
      .map((entry) => ({
        name: entry.toolName,
        title: entry.title,
        description: entry.description,
        ...(entry.toolId === undefined ? {} : { toolId: entry.toolId }),
        actionId: entry.id,
        inputSchema: entry.inputSchema,
        ...(entry.outputSchema === undefined ? {} : { outputSchema: entry.outputSchema }),
        ...(entry.safety === undefined ? {} : { safety: entry.safety }),
        ...(entry.inputHints === undefined ? {} : { inputHints: entry.inputHints }),
        ...(entry.examples === undefined ? {} : { examples: entry.examples }),
        ...(entry.promptSnippet === undefined ? {} : { promptSnippet: entry.promptSnippet }),
        ...(entry.promptGuidelines === undefined ? {} : { promptGuidelines: entry.promptGuidelines }),
        ...(entry.availability === undefined ? {} : { availability: entry.availability }),
      })),
  );
}

export function isActionAvailableOnToolSurface(params: Readonly<{
  actionId: ActionId | string;
  surface?: HappierBuiltInToolSurface;
  isActionEnabled?: ActionEnabledPredicate;
  actionsSettings?: ActionsSettingsV1 | null;
  registry?: ResolvedContributionRegistry;
  pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
}>): boolean {
  return resolveActionToolCatalogAvailability(params).available;
}

export function isActionDirectToolAvailableOnToolSurface(params: Readonly<{
  actionId: ActionId | string;
  surface?: HappierBuiltInToolSurface;
  isActionEnabled?: ActionEnabledPredicate;
  actionsSettings?: ActionsSettingsV1 | null;
  registry?: ResolvedContributionRegistry;
  pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
}>): boolean {
  const surface = params.surface ?? 'agent';
  const builtInSpec = BUILT_IN_ACTION_SPECS_BY_ID.get(String(params.actionId));
  if (builtInSpec) {
    return isActionDirectToolExposedOn(builtInSpec, surface, {
      settings: params.actionsSettings ?? null,
      isActionEnabled: params.isActionEnabled ?? null,
    });
  }

  return resolveActionToolCatalogAvailability({
    actionId: params.actionId,
    surface,
    isActionEnabled: params.isActionEnabled,
    actionsSettings: params.actionsSettings ?? null,
    requireToolBinding: true,
    registry: params.registry,
    pluginToolCatalog: params.pluginToolCatalog,
  }).available;
}

export function createActionToolNameToIdMap(params?: Readonly<{
  surface?: HappierBuiltInToolSurface;
  isActionEnabled?: ActionEnabledPredicate;
  actionsSettings?: ActionsSettingsV1 | null;
  registry?: ResolvedContributionRegistry;
  pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
}>): ReadonlyMap<string, string> {
  const surface = params?.surface ?? 'agent';

  return new Map(
    listActionToolEntries({
      registry: params?.registry,
      pluginToolCatalog: params?.pluginToolCatalog,
    })
      .filter((entry) => (
        entry.surfaces[surface] === true
        && isActionDirectToolAvailableOnToolSurface({
          actionId: entry.id,
          surface,
          isActionEnabled: params?.isActionEnabled,
          actionsSettings: params?.actionsSettings ?? null,
          registry: params?.registry,
          pluginToolCatalog: params?.pluginToolCatalog,
        })
      ))
      .map((entry) => [entry.toolName, entry.id] as const),
  );
}

export function isDirectManualToolAvailable(params: Readonly<{
  toolName: string;
  actionId: ActionId | string;
  surface?: HappierBuiltInToolSurface;
  isActionEnabled?: ActionEnabledPredicate;
  actionsSettings?: ActionsSettingsV1 | null;
  registry?: ResolvedContributionRegistry;
  pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
}>): boolean {
  if (!DIRECT_MANUAL_TOOL_NAMES.has(params.toolName)) {
    return false;
  }

  return isActionAvailableOnToolSurface({
    actionId: params.actionId,
    surface: params.surface,
    isActionEnabled: params.isActionEnabled,
    actionsSettings: params.actionsSettings ?? null,
    registry: params.registry,
    pluginToolCatalog: params.pluginToolCatalog,
  });
}

export function filterBuiltInToolsForSurface(
  tools: readonly HappierBuiltInToolDefinition[],
  params?: Readonly<{
    surface?: HappierBuiltInToolSurface;
    isActionEnabled?: ActionEnabledPredicate;
    actionsSettings?: ActionsSettingsV1 | null;
    registry?: ResolvedContributionRegistry;
    pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
  }>,
): readonly HappierBuiltInToolDefinition[] {
  return tools.filter((tool) => {
    const actionId = getEquivalentActionIdForBuiltInTool(tool.name, {
      registry: params?.registry,
      pluginToolCatalog: params?.pluginToolCatalog,
    });
    if (!actionId) return true;
    if (isDirectManualToolAvailable({
      toolName: tool.name,
      actionId,
      surface: params?.surface,
      isActionEnabled: params?.isActionEnabled,
      actionsSettings: params?.actionsSettings ?? null,
      registry: params?.registry,
      pluginToolCatalog: params?.pluginToolCatalog,
    })) {
      return true;
    }
    return isActionDirectToolAvailableOnToolSurface({
      actionId,
      surface: params?.surface,
      isActionEnabled: params?.isActionEnabled,
      actionsSettings: params?.actionsSettings ?? null,
      registry: params?.registry,
      pluginToolCatalog: params?.pluginToolCatalog,
    });
  });
}
