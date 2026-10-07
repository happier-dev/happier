import { formatWorkflowDefinitionRefV1 } from './workflowDefinitionRefV1.js';
import type { PluginWorkflowContributionV1 } from '../plugins/contributions/workflows.js';
import type { WorkflowPluginSourceV1 } from './workflowPluginSourceContractV1.js';
export { WorkflowPluginSourceV1Schema } from './workflowPluginSourceContractV1.js';
export type { WorkflowPluginSourceV1, WorkflowPluginSourceReaderV1 } from './workflowPluginSourceContractV1.js';

/** Projects a catalog-admitted contribution; ingestion owns qualification and validation. */
export function projectWorkflowPluginSourceV1(input: Readonly<{
  pluginId: string; pluginVersion: string; definition: PluginWorkflowContributionV1;
}>): WorkflowPluginSourceV1 {
  const { id, ...definition } = input.definition;
  return { ...definition, pluginId: input.pluginId, version: input.pluginVersion,
    workflow: formatWorkflowDefinitionRefV1({ kind: 'plugin', contribution: { pluginId: input.pluginId, localId: id } }) };
}
