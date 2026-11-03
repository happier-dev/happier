import { isActionDirectToolExposedOn } from '@happier-dev/protocol/actions/actionToolExposure';
import { isActionEnabledByActionsSettings } from '@happier-dev/protocol/actions/actionSettings';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { getDefaultActionToolExposureMode, resolveActionSurfaceAvailability, resolveActionToolExposureModeForSurface } from '@happier-dev/protocol/actions/actionSurfaceAvailability';
import { listActionSpecs } from '@happier-dev/protocol/actions/actionSpecs';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { ActionId, ActionSurfaceAvailability, ActionSurfaces, ActionsSettingsV1 } from '@happier-dev/protocol';
import { formatQualifiedPluginActionId, parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';

import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
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
  contextualDefaults?: import('@happier-dev/protocol').ActionContextualDefaults;
  outputSchema?: unknown;
  safety?: 'safe' | 'danger';
  inputHints?: unknown;
  examples?: unknown;
  promptSnippet?: string;
  promptGuidelines?: readonly string[];
  availability?: unknown;
  toolExposure?: ProjectedPluginToolCatalogEntry['toolExposure'];
  provenance: ResolvedContributionProvenance;
}>;

/** One projection's lookup indexes; plugin policy is read anew for each projection. */
type ActionToolCatalog = Readonly<{
  entries: readonly ActionToolEntry[];
  byId: ReadonlyMap<string, ActionToolEntry>;
  byToolName: ReadonlyMap<string, ActionToolEntry>;
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
      ...(spec.examples ? { examples: spec.examples } : {}),
      ...(spec.contextualDefaults ? { contextualDefaults: spec.contextualDefaults } : {}),
      provenance: 'first_party' as const,
    }))
    .filter((entry) => entry.toolName.length > 0),
);
const BUILT_IN_ACTION_SPECS_BY_ID = new Map(
  listActionSpecs().map((spec) => [String(spec.id), spec] as const),
);
const BUILT_IN_ACTION_TOOL_CATALOG = indexActionToolEntries(BUILT_IN_ACTION_TOOL_ENTRIES);

const MANUAL_TOOL_EQUIVALENT_ACTION_IDS = new Map<string, ActionId>([
  ['change_title', 'session.title.set'],
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
  return params?.registry ?? activeRegistry ?? readCurrentContributionRegistry();
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
    ...(tool.contextualDefaults ? { contextualDefaults: tool.contextualDefaults } : {}),
    ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
    safety: tool.safety,
    ...(tool.inputHints === undefined ? {} : { inputHints: tool.inputHints }),
    ...(tool.examples === undefined ? {} : { examples: tool.examples }),
    ...(tool.promptSnippet === undefined ? {} : { promptSnippet: tool.promptSnippet }),
    ...(tool.promptGuidelines === undefined ? {} : { promptGuidelines: tool.promptGuidelines }),
    ...(tool.availability === undefined ? {} : { availability: tool.availability }),
    ...(tool.toolExposure === undefined ? {} : { toolExposure: tool.toolExposure }),
    provenance: 'external',
  };
}

function indexActionToolEntries(entries: readonly ActionToolEntry[]): ActionToolCatalog {
  const byToolName = new Map<string, ActionToolEntry>();
  const byId = new Map<string, ActionToolEntry>();
  for (const entry of entries) {
    if (byToolName.has(entry.toolName)) continue;
    byToolName.set(entry.toolName, entry);
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
  }
  return { entries: Object.freeze([...byToolName.values()]), byId, byToolName };
}

export function createActionToolCatalog(params?: Readonly<{
  registry?: ResolvedContributionRegistry;
  pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
}>): ActionToolCatalog {
  const activeRegistry = resolveCurrentRuntimeRegistry();
  const pluginToolCatalog = params?.pluginToolCatalog
    ?? (activeRegistry && (!params?.registry || activeRegistry.contributes === params.registry)
      ? projectExecutablePluginToolCatalog(activeRegistry)
      : []);
  if (pluginToolCatalog.length === 0) return BUILT_IN_ACTION_TOOL_CATALOG;
  return indexActionToolEntries([
    ...BUILT_IN_ACTION_TOOL_ENTRIES,
    ...pluginToolCatalog.map(toPluginToolEntry),
  ]);
}

function getActionToolEntryById(actionId: string, params?: Readonly<{
  registry?: ResolvedContributionRegistry;
  pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
}>, catalog?: ActionToolCatalog): ActionToolEntry | null {
  return (catalog ?? createActionToolCatalog(params)).byId.get(actionId) ?? null;
}

function getPluginActionContributionById(
  actionId: string,
  params?: Readonly<{ registry?: ResolvedContributionRegistry }>,
): ResolvedActionContribution | null {
  const identity = parseQualifiedPluginActionId(actionId);
  return identity
    ? resolveActionToolRegistry(params).actionsById?.get(buildQualifiedPluginContributionKey(identity)) ?? null
    : null;
}

function getActionAvailableSurfaces(
  surfaces: Readonly<Record<HappierBuiltInToolSurface, boolean>> | Readonly<ActionSurfaces>,
): readonly (keyof ActionSurfaces)[] {
  return Object.entries(surfaces)
    .filter((entry): entry is [keyof ActionSurfaces, true] => entry[1] === true)
    .map(([surface]) => surface);
}

function resolvePluginActionSettings(
  actionId: string,
  surface: HappierBuiltInToolSurface,
  settings: ActionsSettingsV1 | null | undefined,
  toolExposure?: ProjectedPluginToolCatalogEntry['toolExposure'],
): Readonly<{
  enabled: boolean;
  settingsState: ActionToolCatalogAvailability['settingsState'];
  defaultToolExposureMode: 'direct' | 'discoverable_only';
  effectiveToolExposureMode: 'direct' | 'discoverable_only';
}> {
  const identity = parseQualifiedPluginActionId(actionId);
  const settingsActionId = identity ? formatQualifiedPluginActionId(identity) : null;
  const enabled = settingsActionId !== null && (
    !settings
    || isActionEnabledByActionsSettings(settingsActionId, settings, { surface })
  );
  return {
    enabled,
    settingsState: !settings
      ? 'unknown'
      : !enabled
        ? 'disabled'
        : settingsActionId && isApprovalRequiredByActionsSettings(settingsActionId, settings, { surface })
          ? 'approval_required'
          : 'enabled',
    defaultToolExposureMode: getDefaultActionToolExposureMode({ id: actionId, toolExposure }, surface),
    effectiveToolExposureMode: resolveActionToolExposureModeForSurface({ id: actionId, toolExposure }, surface, settings),
  };
}

/** Applies surface/preferences to an Action admitted by the current catalog owner. */
export function resolveDiscoveredPluginActionAvailability(params: Readonly<{
  actionId: string;
  surfaces: Readonly<ActionSurfaces>;
  surface: HappierBuiltInToolSurface;
  actionsSettings?: ActionsSettingsV1 | null;
  provenance?: ResolvedContributionProvenance;
  toolExposure?: ProjectedPluginToolCatalogEntry['toolExposure'];
}>): ActionToolCatalogAvailability {
  const { actionId, surface } = params;
  const availableSurfaces = getActionAvailableSurfaces(params.surfaces);
  const provenance = params.provenance ?? 'external';
  if (params.surfaces[surface] !== true) return {
    available: false, reason: 'unsupported_surface', actionId, surface, availableSurfaces, provenance,
  };
  const settings = resolvePluginActionSettings(actionId, surface, params.actionsSettings, params.toolExposure);
  return {
    available: settings.enabled,
    reason: settings.enabled ? 'available' : 'disabled_by_settings',
    actionId, surface, availableSurfaces, provenance,
    settingsState: settings.settingsState,
    defaultToolExposureMode: settings.defaultToolExposureMode,
    effectiveToolExposureMode: settings.effectiveToolExposureMode,
  };
}

export function resolveActionToolCatalogAvailability(params: Readonly<{
  actionId: ActionId | string;
  /** Select the Action's optional named-tool presentation. */
  toolName?: string;
  surface?: HappierBuiltInToolSurface;
  isActionEnabled?: ActionEnabledPredicate;
  actionsSettings?: ActionsSettingsV1 | null;
  sessionMemoryEnabled?: boolean;
  requireToolBinding?: boolean | null;
  registry?: ResolvedContributionRegistry;
  pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
}>, catalog?: ActionToolCatalog): ActionToolCatalogAvailability {
  const surface = params.surface ?? 'agent';
  const actionId = String(params.actionId);
  const builtInSpec = BUILT_IN_ACTION_SPECS_BY_ID.get(actionId);
  if (builtInSpec) {
    return {
      ...resolveActionSurfaceAvailability({
        actionId: builtInSpec.id as ActionId,
        surface,
        settings: params.actionsSettings ?? null,
        sessionMemoryEnabled: params.sessionMemoryEnabled,
        isActionEnabled: params.isActionEnabled ?? null,
        requireToolBinding: params.requireToolBinding ?? null,
      }),
      provenance: 'first_party',
    };
  }

  const projectedTool = params.toolName
    ? (catalog ?? createActionToolCatalog(params)).byToolName.get(params.toolName)
    : getActionToolEntryById(actionId, {
      registry: params.registry,
      pluginToolCatalog: params.pluginToolCatalog,
    }, catalog);
  if (projectedTool?.id === actionId) {
    return resolveDiscoveredPluginActionAvailability({
      actionId, surface, actionsSettings: params.actionsSettings,
      surfaces: { ...projectedTool.surfaces, ui: false, voice: false, rpc: false, api: false, plugin: false },
      toolExposure: projectedTool.toolExposure,
    });
  }

  // An explicitly supplied catalog is a bounded admission snapshot (for
  // example, the active Agent-composition turn). It is authoritative for
  // direct Tools, so an omitted plugin tool must not fall through to a mutable
  // global registry and bypass the admitted selection. Generic action_execute
  // separately uses the current Action discovery owner, not this Tool lookup.
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
  const availability = resolveDiscoveredPluginActionAvailability({
    actionId, surface, actionsSettings: params.actionsSettings,
    surfaces: pluginAction.definition.surfaces, provenance: pluginAction.provenance,
    toolExposure: pluginAction.definition.toolExposure,
  });
  if (!availability.available) return availability;
  if (params.requireToolBinding && !getActionToolEntryById(actionId, {
    registry: params.registry,
    pluginToolCatalog: params.pluginToolCatalog,
  }, catalog)) {
    return {
      ...availability,
      available: false,
      reason: 'missing_tool_binding',
      actionId,
      surface,
      availableSurfaces,
      provenance: pluginAction.provenance,
    };
  }

  return availability;
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
  catalog?: ActionToolCatalog,
): string | null {
  return (catalog ?? createActionToolCatalog(params)).byToolName.get(toolName)?.id ?? null;
}

export function getEquivalentActionIdForBuiltInTool(
  toolName: string,
  params?: Readonly<{
    registry?: ResolvedContributionRegistry;
    pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
  }>,
  catalog?: ActionToolCatalog,
): string | null {
  return MANUAL_TOOL_EQUIVALENT_ACTION_IDS.get(toolName) ?? getActionToolIdForToolName(toolName, params, catalog);
}

export function listPluginActionBackedTools(params?: Readonly<{
  registry?: ResolvedContributionRegistry;
  pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
}>, catalog?: ActionToolCatalog): readonly HappierBuiltInToolDefinition[] {
  return Object.freeze(
    (catalog ?? createActionToolCatalog(params)).entries
      .filter((entry) => entry.provenance === 'external')
      .map((entry) => ({
        name: entry.toolName,
        title: entry.title,
        description: entry.description,
        ...(entry.toolId === undefined ? {} : { toolId: entry.toolId }),
        actionId: entry.id,
        inputSchema: entry.inputSchema,
        ...(entry.contextualDefaults ? { contextualDefaults: entry.contextualDefaults } : {}),
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
  sessionMemoryEnabled?: boolean;
  registry?: ResolvedContributionRegistry;
  pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
}>, catalog?: ActionToolCatalog): boolean {
  return resolveActionToolCatalogAvailability(params, catalog).available;
}

export function isActionDirectToolAvailableOnToolSurface(params: Readonly<{
  actionId: ActionId | string;
  toolName?: string;
  surface?: HappierBuiltInToolSurface;
  isActionEnabled?: ActionEnabledPredicate;
  actionsSettings?: ActionsSettingsV1 | null;
  sessionMemoryEnabled?: boolean;
  requiredDirectActionIds?: readonly ActionId[];
  registry?: ResolvedContributionRegistry;
  pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
}>, catalog?: ActionToolCatalog): boolean {
  const surface = params.surface ?? 'agent';
  const builtInSpec = BUILT_IN_ACTION_SPECS_BY_ID.get(String(params.actionId));
  if (builtInSpec) {
    const ordinarilyExposed = isActionDirectToolExposedOn(builtInSpec, surface, {
      settings: params.actionsSettings ?? null,
      sessionMemoryEnabled: params.sessionMemoryEnabled,
      isActionEnabled: params.isActionEnabled ?? null,
    });
    if (ordinarilyExposed) return true;
    if (
      surface !== 'agent'
      || !params.requiredDirectActionIds?.includes(params.actionId as ActionId)
      || params.actionsSettings?.actions?.[params.actionId as ActionId]?.toolExposureModes?.agent === 'discoverable_only'
    ) return false;
    return resolveActionToolCatalogAvailability({
      actionId: params.actionId,
      surface,
      isActionEnabled: params.isActionEnabled,
      actionsSettings: params.actionsSettings ?? null,
      sessionMemoryEnabled: params.sessionMemoryEnabled,
      registry: params.registry,
      pluginToolCatalog: params.pluginToolCatalog,
    }, catalog).available;
  }

  const availability = resolveActionToolCatalogAvailability({
    actionId: params.actionId,
    toolName: params.toolName,
    surface,
    isActionEnabled: params.isActionEnabled,
    actionsSettings: params.actionsSettings ?? null,
    sessionMemoryEnabled: params.sessionMemoryEnabled,
    requireToolBinding: true,
    registry: params.registry,
    pluginToolCatalog: params.pluginToolCatalog,
  }, catalog);
  return availability.available && availability.effectiveToolExposureMode === 'direct';
}

export function createActionToolNameToIdMap(params?: Readonly<{
  surface?: HappierBuiltInToolSurface;
  isActionEnabled?: ActionEnabledPredicate;
  actionsSettings?: ActionsSettingsV1 | null;
  sessionMemoryEnabled?: boolean;
  requiredDirectActionIds?: readonly ActionId[];
  registry?: ResolvedContributionRegistry;
  pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
}>): ReadonlyMap<string, string> {
  const surface = params?.surface ?? 'agent';
  const catalog = createActionToolCatalog(params);

  return new Map(
    catalog.entries
      .filter((entry) => (
        entry.surfaces[surface] === true
        && isActionDirectToolAvailableOnToolSurface({
          actionId: entry.id,
          toolName: entry.toolName,
          surface,
          isActionEnabled: params?.isActionEnabled,
          actionsSettings: params?.actionsSettings ?? null,
          sessionMemoryEnabled: params?.sessionMemoryEnabled,
          requiredDirectActionIds: params?.requiredDirectActionIds,
          registry: params?.registry,
          pluginToolCatalog: params?.pluginToolCatalog,
        }, catalog)
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
  sessionMemoryEnabled?: boolean;
  requiredDirectActionIds?: readonly ActionId[];
  registry?: ResolvedContributionRegistry;
  pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
}>, catalog?: ActionToolCatalog): boolean {
  const surface = params.surface ?? 'agent';
  if (DIRECT_MANUAL_TOOL_NAMES.has(params.toolName)) {
    const explicitMode = params.actionsSettings?.actions?.[params.actionId as ActionId]?.toolExposureModes?.[surface];
    if (explicitMode === 'discoverable_only') return false;
    return isActionAvailableOnToolSurface({
      actionId: params.actionId,
      surface,
      isActionEnabled: params.isActionEnabled,
      actionsSettings: params.actionsSettings ?? null,
      sessionMemoryEnabled: params.sessionMemoryEnabled,
      registry: params.registry,
      pluginToolCatalog: params.pluginToolCatalog,
    }, catalog);
  }

  return isActionDirectToolAvailableOnToolSurface({
    actionId: params.actionId,
    toolName: params.toolName,
    surface,
    isActionEnabled: params.isActionEnabled,
    actionsSettings: params.actionsSettings ?? null,
    sessionMemoryEnabled: params.sessionMemoryEnabled,
    requiredDirectActionIds: params.requiredDirectActionIds,
    registry: params.registry,
    pluginToolCatalog: params.pluginToolCatalog,
  }, catalog);
}

export function filterBuiltInToolsForSurface(
  tools: readonly HappierBuiltInToolDefinition[],
  params?: Readonly<{
    surface?: HappierBuiltInToolSurface;
    isActionEnabled?: ActionEnabledPredicate;
    actionsSettings?: ActionsSettingsV1 | null;
    sessionMemoryEnabled?: boolean;
    requiredDirectActionIds?: readonly ActionId[];
    registry?: ResolvedContributionRegistry;
    pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
  }>,
  admittedCatalog?: ActionToolCatalog,
): readonly HappierBuiltInToolDefinition[] {
  const catalog = admittedCatalog ?? createActionToolCatalog(params);
  return tools.filter((tool) => {
    const actionId = getEquivalentActionIdForBuiltInTool(tool.name, {
      registry: params?.registry,
      pluginToolCatalog: params?.pluginToolCatalog,
    }, catalog);
    if (!actionId) return true;
    return isDirectManualToolAvailable({
      toolName: tool.name,
      actionId,
      surface: params?.surface,
      isActionEnabled: params?.isActionEnabled,
      actionsSettings: params?.actionsSettings ?? null,
      sessionMemoryEnabled: params?.sessionMemoryEnabled,
      requiredDirectActionIds: params?.requiredDirectActionIds,
      registry: params?.registry,
      pluginToolCatalog: params?.pluginToolCatalog,
    }, catalog);
  });
}
