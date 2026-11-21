import { describe, expect, it } from 'vitest';
// The live Action entry point must initialize before the public Workflow barrel.
import '../actions/actionExecutor.js';
import { WorkflowActionInputSchemasV1 } from './actionsV1.js';
import { projectWorkflowPluginSourceV1, WorkflowPluginSourceV1Schema } from './index.js';
import { normalizePluginWorkflowContributionV1 } from './workflowPluginSourceV1.js';

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
      pluginId: 'com.acme.workflows', pluginVersion: '1.0.0',
      definition: normalizePluginWorkflowContributionV1(definition, 'com.acme.workflows'),
    });
    expect(WorkflowPluginSourceV1Schema.parse(source)).toMatchObject({
      workflow: 'plugin:com.acme.workflows/review',
      definition: { blocks: [{ actionId: 'com.acme.workflows/actions/publish' }] },
    });
  });
  it('keeps an external participant declaration and item binding through the strict source reader', () => {
    const definition = { id: 'opinions', title: 'Opinions', definition: { version: 1 as const,
      inputs: [{ name: 'participants', valueType: 'json' as const, multiple: true, required: true,
        inputType: { hostType: 'agentParticipant' as const } }], defaults: {},
      blocks: [{ kind: 'loop' as const, id: 'voices', repetition: { kind: 'items' as const,
        items: { kind: 'input' as const, name: 'participants' }, execution: 'parallel' as const,
        failurePolicy: 'collect_outcomes' as const }, body: [{ kind: 'step' as const, id: 'answer',
        document: { text: 'Answer', references: [], attachments: [] },
        execution: { participant: { kind: 'item' as const, field: 'value' as const } } }] }],
    } };
    const source = projectWorkflowPluginSourceV1({ pluginId: 'com.acme.workflows', pluginVersion: '1.0.0',
      definition: normalizePluginWorkflowContributionV1(definition, 'com.acme.workflows') });
    expect(WorkflowPluginSourceV1Schema.parse(source)).toMatchObject({ definition: {
      inputs: [{ name: 'participants', multiple: true, inputType: { hostType: 'agentParticipant' } }],
      blocks: [{ body: [{ execution: { participant: { kind: 'item', field: 'value' } } }] }],
    } });
  });
});
