import { z } from 'zod';
import { ActionIdSchema } from '../../actions/actionIds.js';
import { WorkflowDefinitionV1Schema, type WorkflowValidationIssue } from '../../workflows/workflowV1.js';
import { walkWorkflowBlocks } from '../../workflows/workflowDefinitionEditV1.js';
import { validateWorkflowDefinition } from '../../workflows/workflowValidationV1.js';
import {
  PluginContributionLocalIdSchema,
  buildQualifiedPluginContributionKey,
  createPluginContributionIdentity,
  parseQualifiedPluginContributionKey,
  qualifyPluginContributionReferenceV1,
} from '../contributionIdentity.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';

/** Read-only plugin definitions use the same grammar as library workflows. */
export const PluginWorkflowContributionV1Schema = z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: z.string().trim().min(1),
  description: z.string().optional(),
  definition: WorkflowDefinitionV1Schema,
}).strict();
export type PluginWorkflowContributionV1 = z.infer<typeof PluginWorkflowContributionV1Schema>;

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

/** Family-owned qualification and semantic admission, shared by catalog and source projection. */
export function normalizePluginWorkflowContributionV1(value: unknown, pluginId: string): PluginWorkflowContributionV1 {
  // Parsing produces a private copy: never rewrite the plugin's authored manifest.
  const contribution = PluginWorkflowContributionV1Schema.parse(value);
  for (const block of walkWorkflowBlocks(contribution.definition.blocks)) {
    if (block.kind !== 'action' || ActionIdSchema.safeParse(block.actionId).success
      || parseQualifiedPluginContributionKey(block.actionId) !== null) continue;
    const local = PluginContributionLocalIdSchema.safeParse(block.actionId);
    if (!local.success) continue;
    block.actionId = buildQualifiedPluginContributionKey(createPluginContributionIdentity(
      qualifyPluginContributionReferenceV1(local.data, pluginId),
    ));
  }
  // Availability stays at run admission. Missing Actions/children retain their
  // exact qualified references; structural graph errors never enter the catalog.
  const checked = validateWorkflowDefinition(contribution.definition);
  if (!checked.valid || !checked.normalizedDefinition) {
    throw new PluginWorkflowContributionErrorV1(pluginId, contribution.id, checked.issues);
  }
  return { ...contribution, definition: checked.normalizedDefinition };
}
