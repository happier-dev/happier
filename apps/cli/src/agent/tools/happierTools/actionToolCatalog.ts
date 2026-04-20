import { listActionSpecs, type ActionId } from '@happier-dev/protocol';

import { getResolvedContributionRegistry } from '@/extensions/registry/createResolvedContributionRegistry';
import type {
  ResolvedActionContribution,
  ResolvedContributionProvenance,
  ResolvedContributionRegistry,
  ResolvedContributionSourceKind,
} from '@/extensions/registry/types';
import { pluginReloadController } from '@/extensions/reload/singleton';
import type { HappierBuiltInToolDefinition } from './types';

type ActionEnabledPredicate = (id: ActionId) => boolean;
export type HappierBuiltInToolSurface = 'mcp' | 'cli' | 'session_agent';

type ActionToolEntry = Readonly<{
  id: string;
  toolName: string;
  surfaces: Readonly<Record<HappierBuiltInToolSurface, boolean>>;
  title: string;
  description: string;
  inputSchema: unknown;
  provenance: ResolvedContributionProvenance;
  sourceKind: ResolvedContributionSourceKind;
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
      sourceKind: 'bundled' as const,
    }))
    .filter((entry) => entry.toolName.length > 0),
);

const MANUAL_TOOL_EQUIVALENT_ACTION_IDS = new Map<string, ActionId>([
  ['change_title', 'session.title.set'],
  ['action_spec_search', 'action.spec.search'],
  ['action_spec_get', 'action.spec.get'],
  ['action_options_resolve', 'action.options.resolve'],
]);

function resolveActionToolRegistry(params?: Readonly<{
  registry?: ResolvedContributionRegistry;
}>): ResolvedContributionRegistry {
  const activeRegistry = pluginReloadController.getState().activeRegistry?.contributions;
  return params?.registry ?? activeRegistry ?? getResolvedContributionRegistry();
}

function isTrustedPluginToolContribution(action: ResolvedActionContribution): boolean {
  return action.provenance === 'external' && action.sourceSpec?.trustPolicy === 'local_trusted';
}

function toPluginActionToolEntry(action: ResolvedActionContribution): ActionToolEntry | null {
  if (!isTrustedPluginToolContribution(action)) {
    return null;
  }

  const toolName = String(action.definition.bindings?.mcpToolName ?? '').trim();
  if (!toolName) {
    return null;
  }

  return {
    id: action.definition.id,
    toolName,
    surfaces: action.definition.surfaces,
    title: action.definition.title,
    description: action.definition.description ?? action.definition.title,
    inputSchema: action.definition.inputSchema,
    provenance: action.provenance,
    sourceKind: action.source.kind,
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
}>): readonly ActionToolEntry[] {
  const pluginEntries = resolveActionToolRegistry(params).actions.flatMap((action) => {
    const entry = toPluginActionToolEntry(action);
    return entry ? [entry] : [];
  });

  return dedupeActionToolEntries([
    ...BUILT_IN_ACTION_TOOL_ENTRIES,
    ...pluginEntries,
  ]);
}

function getActionToolEntryById(actionId: string, params?: Readonly<{
  registry?: ResolvedContributionRegistry;
}>): ActionToolEntry | null {
  return listActionToolEntries(params).find((entry) => entry.id === actionId) ?? null;
}

export function isActionKnownToToolCatalog(
  actionId: ActionId | string,
  params?: Readonly<{ registry?: ResolvedContributionRegistry }>,
): boolean {
  return getActionToolEntryById(String(actionId), params) !== null;
}

export function getActionToolIdForToolName(
  toolName: string,
  params?: Readonly<{ registry?: ResolvedContributionRegistry }>,
): string | null {
  return listActionToolEntries(params).find((entry) => entry.toolName === toolName)?.id ?? null;
}

export function getEquivalentActionIdForBuiltInTool(
  toolName: string,
  params?: Readonly<{ registry?: ResolvedContributionRegistry }>,
): string | null {
  return MANUAL_TOOL_EQUIVALENT_ACTION_IDS.get(toolName) ?? getActionToolIdForToolName(toolName, params);
}

export function listPluginActionBackedTools(params?: Readonly<{
  registry?: ResolvedContributionRegistry;
}>): readonly HappierBuiltInToolDefinition[] {
  return Object.freeze(
    listActionToolEntries(params)
      .filter((entry) => entry.provenance === 'external')
      .map((entry) => ({
        name: entry.toolName,
        title: entry.title,
        description: entry.description,
        inputSchema: entry.inputSchema,
      })),
  );
}

export function isActionAvailableOnToolSurface(params: Readonly<{
  actionId: ActionId | string;
  surface?: HappierBuiltInToolSurface;
  isActionEnabled?: ActionEnabledPredicate;
  registry?: ResolvedContributionRegistry;
}>): boolean {
  const surface = params.surface ?? 'session_agent';
  const isActionEnabled = params.isActionEnabled ?? (() => true);
  const actionEntry = getActionToolEntryById(String(params.actionId), { registry: params.registry });
  if (!actionEntry) {
    return false;
  }
  if (actionEntry.surfaces[surface] !== true) {
    return false;
  }
  return actionEntry.provenance === 'external' ? true : isActionEnabled(actionEntry.id as ActionId);
}

export function createActionToolNameToIdMap(params?: Readonly<{
  surface?: HappierBuiltInToolSurface;
  isActionEnabled?: ActionEnabledPredicate;
  registry?: ResolvedContributionRegistry;
}>): ReadonlyMap<string, string> {
  const surface = params?.surface ?? 'session_agent';

  return new Map(
    listActionToolEntries({ registry: params?.registry })
      .filter((entry) => isActionAvailableOnToolSurface({
        actionId: entry.id,
        surface,
        isActionEnabled: params?.isActionEnabled,
        registry: params?.registry,
      }))
      .map((entry) => [entry.toolName, entry.id] as const),
  );
}

export function filterBuiltInToolsForSurface(
  tools: readonly HappierBuiltInToolDefinition[],
  params?: Readonly<{
    surface?: HappierBuiltInToolSurface;
    isActionEnabled?: ActionEnabledPredicate;
    registry?: ResolvedContributionRegistry;
  }>,
): readonly HappierBuiltInToolDefinition[] {
  return tools.filter((tool) => {
    const actionId = getEquivalentActionIdForBuiltInTool(tool.name, { registry: params?.registry });
    if (!actionId) return true;
    return isActionAvailableOnToolSurface({
      actionId,
      surface: params?.surface,
      isActionEnabled: params?.isActionEnabled,
      registry: params?.registry,
    });
  });
}
