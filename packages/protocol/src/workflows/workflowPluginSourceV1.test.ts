import { describe, expect, it } from 'vitest';
// The live Action entry point must initialize before the public Workflow barrel.
import '../actions/actionExecutor.js';
import { WorkflowActionInputSchemasV1 } from './actionsV1.js';
import { projectWorkflowPluginSourceV1, WorkflowPluginSourceV1Schema } from './index.js';

describe('plugin Workflow source initialization', () => {
  it('initializes Action schemas before projecting semantically admitted plugin Workflows', () => {
    expect(WorkflowActionInputSchemasV1['workflow.validate'].safeParse({
      definition: { blocks: ['Work'] },
    }).success).toBe(true);

    const definition = { id: 'review', title: 'Review', definition: {
      version: 1 as const,
      blocks: [{ kind: 'action' as const, id: 'publish', actionId: 'publish', input: {} }],
    } };
    const source = projectWorkflowPluginSourceV1({
      pluginId: 'com.acme.workflows', pluginVersion: '1.0.0', definition,
    });
    expect(WorkflowPluginSourceV1Schema.parse(source)).toMatchObject({
      workflow: 'plugin:com.acme.workflows/review',
      definition: { blocks: [{ actionId: 'com.acme.workflows/publish' }] },
    });
    expect(() => projectWorkflowPluginSourceV1({
      pluginId: 'com.acme.workflows', pluginVersion: '1.0.0',
      definition: { ...definition, definition: {
        ...definition.definition, blocks: [...definition.definition.blocks, ...definition.definition.blocks],
      } },
    })).toThrow(expect.objectContaining({ code: 'plugin_workflow_invalid' }));
  });
});
