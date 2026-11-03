import type {
  ActionContextualDefaults,
  ActionInputHints,
  PluginJsonSchemaV2,
  PluginActionContributionV2,
} from '@happier-dev/protocol';
import { formatQualifiedPluginActionId, parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/public-types';
import { readResolvedActionContribution } from '@/plugins/projection/registry/actions';

import type { ResolvedExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';

type PluginToolCatalogRuntimeRegistry = Pick<
  ResolvedExecutablePluginRuntimeRegistry,
  'contributes' | 'targetActionInvocations' | 'readPluginOccurrenceId'
>;

export type ProjectedPluginToolCatalogEntry = Readonly<{
  toolId: string;
  actionId: string;
  name: string;
  title: string;
  description: string;
  inputSchema: PluginJsonSchemaV2;
  contextualDefaults?: ActionContextualDefaults;
  outputSchema?: NonNullable<PluginActionContributionV2['resultSchema']>;
  inputHints?: ActionInputHints;
  safety?: 'safe' | 'danger';
  examples?: NonNullable<NonNullable<PluginActionContributionV2['tool']>['examples']>;
  promptSnippet?: NonNullable<NonNullable<PluginActionContributionV2['tool']>['promptSnippet']>;
  promptGuidelines?: readonly string[];
  availability?: NonNullable<PluginActionContributionV2['availability']>;
  toolExposure?: PluginActionContributionV2['toolExposure'];
  surfaces: readonly ('agent' | 'mcp' | 'cli')[];
  /**
   * Ephemeral admission fence. The executable catalog projection never
   * produces this field; a catalog snapshot owner binds the admitted Action
   * contributor before handing the Tool to a long-lived consumer.
   */
  expectedContributorOccurrenceId?: string;
}>;

function readLocalizedText(
  value: string | Readonly<{ fallback: string }> | null | undefined,
): string | null {
  const normalized = resolvePluginLocalizedStringV2Text(value).trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Projects optional named-tool presentation from the current Actions.
 * The runtime registry remains the sole currentness, policy, and action owner;
 * this is a read-only transport/presentation view.
 */
export function projectExecutablePluginToolCatalog(
  runtimeRegistry: PluginToolCatalogRuntimeRegistry,
): readonly ProjectedPluginToolCatalogEntry[] {
  const projected: ProjectedPluginToolCatalogEntry[] = [];
  for (const action of runtimeRegistry.contributes.actions) {
    const declaration = action.admittedTarget?.declaration;
    const tool = declaration?.tool;
    if (!action.pluginId || !action.identity || !declaration || !tool) continue;
    const surfaces = declaration.surfaces.filter((surface) => surface === 'agent' || surface === 'mcp' || surface === 'cli');
    if (surfaces.length === 0) continue;
    const policy = runtimeRegistry.targetActionInvocations?.evaluateCatalogPolicy(
      action.pluginId,
      action.definition.id,
    );
    if (policy?.outcome !== 'visible') continue;
    const name = tool.name.trim();
    const title = readLocalizedText(tool.title) ?? action.definition.title;
    if (!name || !title) continue;
    projected.push(Object.freeze({
      toolId: `${action.pluginId}/${action.definition.id}`,
      actionId: formatQualifiedPluginActionId(action.identity),
      name,
      title,
      description: readLocalizedText(tool.description) ?? action.definition.description ?? title,
      inputSchema: declaration.inputSchema ?? {},
      ...(action.definition.contextualDefaults === undefined
        ? {}
        : { contextualDefaults: action.definition.contextualDefaults }),
      ...(declaration.resultSchema === undefined ? {} : { outputSchema: declaration.resultSchema }),
      ...(action.definition.inputHints ? { inputHints: action.definition.inputHints } : {}),
      safety: action.definition.safety,
      ...(tool.examples === undefined ? {} : { examples: tool.examples }),
      ...(tool.promptSnippet === undefined ? {} : { promptSnippet: tool.promptSnippet }),
      ...(tool.promptGuidelines === undefined ? {} : {
        promptGuidelines: Object.freeze([...tool.promptGuidelines]),
      }),
      ...(declaration.availability === undefined ? {} : { availability: declaration.availability }),
      ...(declaration.toolExposure === undefined ? {} : { toolExposure: declaration.toolExposure }),
      surfaces: Object.freeze(surfaces),
    }));
  }
  return Object.freeze(projected.sort((left, right) => (
    left.name.localeCompare(right.name) || left.toolId.localeCompare(right.toolId)
  )));
}

/**
 * Binds a transport-facing Tool catalog to the Action contributor occurrence
 * owned by this exact executable-registry snapshot. Long-lived
 * MCP consumers must carry this fence back to the same registry before an
 * Action handler can begin.
 */
export function projectOccurrenceBoundExecutablePluginToolCatalog(
  runtimeRegistry: PluginToolCatalogRuntimeRegistry,
): readonly ProjectedPluginToolCatalogEntry[] {
  return Object.freeze(projectExecutablePluginToolCatalog(runtimeRegistry).flatMap((tool) => {
    const identity = parseQualifiedPluginActionId(tool.actionId);
    const actionPluginId = identity
      ? readResolvedActionContribution(runtimeRegistry.contributes, identity)?.pluginId?.trim()
      : undefined;
    const occurrenceId = actionPluginId
      ? runtimeRegistry.readPluginOccurrenceId?.(actionPluginId)?.trim()
      : undefined;
    return occurrenceId
      ? [Object.freeze({
          ...tool,
          expectedContributorOccurrenceId: occurrenceId,
        })]
      : [];
  }));
}
