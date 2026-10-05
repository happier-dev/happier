import { formatWorkflowDefinitionRefV1 } from './workflowDefinitionRefV1.js';
import { normalizePluginWorkflowContributionV1, type PluginWorkflowContributionV1 } from '../plugins/contributions/workflows.js';
import type { WorkflowPluginSourceV1 } from './workflowPluginSourceContractV1.js';
export { WorkflowPluginSourceV1Schema } from './workflowPluginSourceContractV1.js';
export type { WorkflowPluginSourceV1, WorkflowPluginSourceReaderV1 } from './workflowPluginSourceContractV1.js';

/** Registry and daemon-projection adapters share the same qualified source shape. */
export function projectWorkflowPluginSourceV1(input: Readonly<{
  pluginId: string; pluginVersion: string; definition: PluginWorkflowContributionV1;
}>): WorkflowPluginSourceV1 {
  const { id, ...definition } = normalizePluginWorkflowContributionV1(input.definition, input.pluginId);
  return { ...definition, pluginId: input.pluginId, version: input.pluginVersion,
    workflow: formatWorkflowDefinitionRefV1({ kind: 'plugin', contribution: { pluginId: input.pluginId, localId: id } }) };
}
