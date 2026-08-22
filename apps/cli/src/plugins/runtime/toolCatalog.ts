import type {
  ActionInputHints,
  PluginJsonSchemaV2,
  PluginToolContributionV2,
} from '@happier-dev/protocol';
import { normalizePluginActionInputHintsV2 } from '@happier-dev/protocol';

import {
  evaluateContributionAvailability,
  resolveInvocationContributionPolicyFacts,
} from './policy/evaluate';
import type { ResolvedExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';

type PluginToolCatalogRuntimeRegistry = Pick<
  ResolvedExecutablePluginRuntimeRegistry,
  'contributes' | 'targetActionInvocations'
>;

export type ProjectedPluginToolCatalogEntry = Readonly<{
  toolId: string;
  actionId: string;
  name: string;
  title: string;
  description: string;
  inputSchema: PluginJsonSchemaV2;
  outputSchema?: NonNullable<PluginToolContributionV2['outputSchema']>;
  inputHints?: ActionInputHints;
  safety?: NonNullable<PluginToolContributionV2['safety']>;
  examples?: NonNullable<PluginToolContributionV2['examples']>;
  promptSnippet?: NonNullable<PluginToolContributionV2['promptSnippet']>;
  promptGuidelines?: readonly string[];
  availability?: NonNullable<PluginToolContributionV2['availability']>;
  surfaces: readonly ('agent' | 'mcp' | 'cli')[];
  /**
   * Ephemeral admission fence. The executable catalog projection never
   * produces this field; a catalog snapshot owner binds the admitted Action
   * contributor before handing the Tool to a long-lived consumer.
   */
  expectedContributorImmutableGenerationId?: string;
}>;

function readLocalizedText(
  value: string | Readonly<{ fallback: string }> | null | undefined,
): string | null {
  const text = typeof value === 'string' ? value : value?.fallback;
  const normalized = text?.trim() ?? '';
  return normalized.length > 0 ? normalized : null;
}

/**
 * Serializes the current executable registry's normalized tool declarations.
 * The runtime registry remains the sole currentness, policy, and action owner;
 * this is a read-only transport/presentation view.
 */
export function projectExecutablePluginToolCatalog(
  runtimeRegistry: PluginToolCatalogRuntimeRegistry,
): readonly ProjectedPluginToolCatalogEntry[] {
  const projected: ProjectedPluginToolCatalogEntry[] = [];
  for (const tool of runtimeRegistry.contributes.tools ?? []) {
    if (!tool.pluginId) continue;
    const action = runtimeRegistry.contributes.actionsById?.get(tool.definition.actionId);
    if (!action?.pluginId) continue;
    const policy = runtimeRegistry.targetActionInvocations?.evaluateCatalogPolicy(
      action.pluginId,
      action.definition.id,
    );
    if (policy?.outcome !== 'visible') continue;
    const toolAvailability = evaluateContributionAvailability({
      availability: tool.definition.availability,
      facts: resolveInvocationContributionPolicyFacts(),
    });
    if (toolAvailability.outcome !== 'visible') continue;
    const name = tool.definition.name.trim();
    const title = readLocalizedText(tool.definition.title);
    if (!name || !title) continue;
    projected.push(Object.freeze({
      toolId: `${tool.pluginId}/${tool.definition.id}`,
      actionId: tool.definition.actionId,
      name,
      title,
      description: readLocalizedText(tool.definition.description) ?? title,
      inputSchema: tool.definition.inputSchema ?? {},
      ...(tool.definition.outputSchema === undefined ? {} : { outputSchema: tool.definition.outputSchema }),
      ...(tool.definition.inputHints === undefined
        ? {}
        : { inputHints: normalizePluginActionInputHintsV2(tool.definition.inputHints) }),
      safety: tool.definition.safety,
      ...(tool.definition.examples === undefined ? {} : { examples: tool.definition.examples }),
      ...(tool.definition.promptSnippet === undefined ? {} : { promptSnippet: tool.definition.promptSnippet }),
      ...(tool.definition.promptGuidelines === undefined ? {} : {
        promptGuidelines: Object.freeze([...tool.definition.promptGuidelines]),
      }),
      ...(tool.definition.availability === undefined ? {} : { availability: tool.definition.availability }),
      surfaces: Object.freeze([...tool.definition.surfaces]),
    }));
  }
  return Object.freeze(projected.sort((left, right) => (
    left.name.localeCompare(right.name) || left.toolId.localeCompare(right.toolId)
  )));
}
