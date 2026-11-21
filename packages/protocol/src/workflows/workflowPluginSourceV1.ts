import { ActionIdSchema } from '../actions/actionIds.js';
import type { WorkflowValidationIssue } from './workflowV1.js';
import { walkWorkflowBlocks } from './workflowDefinitionEditV1.js';
import { validateWorkflowDefinition } from './workflowValidationV1.js';
import { PluginContributionLocalIdSchema } from '../plugins/contributionIdentity.js';
import { formatQualifiedPluginActionId, parseQualifiedPluginActionId } from '../plugins/actions/qualifiedActionId.js';
import { PluginWorkflowContributionV1Schema, type PluginWorkflowContributionV1 } from '../plugins/contributions/workflowDeclarationV1.js';

export class PluginWorkflowContributionErrorV1 extends Error {
  readonly code = 'plugin_workflow_invalid';

  constructor(
    readonly pluginId: string,
    readonly workflowId: string,
    readonly issues: readonly WorkflowValidationIssue[],
  ) {
    super(`Invalid plugin Workflow '${pluginId}/${workflowId}': ${issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`);
    this.name = 'PluginWorkflowContributionErrorV1';
  }
}

/** Family-owned qualification and semantic admission before source projection. */
export function normalizePluginWorkflowContributionV1(value: unknown, pluginId: string): PluginWorkflowContributionV1 {
  // Parsing produces a private copy: never rewrite the plugin's authored manifest.
  const contribution = PluginWorkflowContributionV1Schema.parse(value);
  for (const block of walkWorkflowBlocks(contribution.definition.blocks)) {
    if (block.kind !== 'action' || ActionIdSchema.safeParse(block.actionId).success
      || parseQualifiedPluginActionId(block.actionId) !== null) continue;
    const local = PluginContributionLocalIdSchema.safeParse(block.actionId);
    if (!local.success) continue;
    block.actionId = formatQualifiedPluginActionId({ pluginId, localId: local.data });
  }
  // Availability stays at run admission. Missing Actions/children retain their
  // exact qualified references; structural graph errors never enter the catalog.
  const checked = validateWorkflowDefinition(contribution.definition);
  if (!checked.valid || !checked.normalizedDefinition) {
    throw new PluginWorkflowContributionErrorV1(pluginId, contribution.id, checked.issues);
  }
  return { ...contribution, definition: checked.normalizedDefinition };
}
