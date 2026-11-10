import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { WorkflowDefinitionV1Schema } from './workflowV1.js';
import { WorkflowDefinitionRefV1StringSchema, parseWorkflowDefinitionRefV1, formatWorkflowDefinitionRefV1 } from './workflowDefinitionRefV1.js';
import type { PluginWorkflowContributionV1 } from '../plugins/contributions/workflowDeclarationV1.js';

/** Serving descriptor codec, independent of catalog semantic normalization. */
export const WorkflowPluginSourceV1Schema = lazyZodSchema(() => z.strictObject({
  workflow: WorkflowDefinitionRefV1StringSchema,
  pluginId: z.string().check(z.minLength(1)),
  version: z.string().check(z.minLength(1)),
  title: z.string().check(z.minLength(1)),
  description: z.optional(z.string()),
  definition: WorkflowDefinitionV1Schema,
}).check(z.superRefine((source, context) => {
  const ref = parseWorkflowDefinitionRefV1(source.workflow);
  if (ref?.kind !== 'plugin' || ref.contribution.pluginId !== source.pluginId) {
    context.addIssue({ code: 'custom', path: ['workflow'], message: 'Workflow must belong to its declared plugin' });
  }
})));
export type WorkflowPluginSourceV1 = z.infer<typeof WorkflowPluginSourceV1Schema>;
export type WorkflowPluginSourceReaderV1 = () => readonly WorkflowPluginSourceV1[] | Promise<readonly WorkflowPluginSourceV1[]>;

/** Projects an admitted contribution; semantic admission owns qualification and validation. */
export function projectWorkflowPluginSourceV1(input: Readonly<{
  pluginId: string; pluginVersion: string; definition: PluginWorkflowContributionV1;
}>): WorkflowPluginSourceV1 {
  const { id, ...definition } = input.definition;
  return { ...definition, pluginId: input.pluginId, version: input.pluginVersion,
    workflow: formatWorkflowDefinitionRefV1({ kind: 'plugin', contribution: { pluginId: input.pluginId, localId: id } }) };
}
