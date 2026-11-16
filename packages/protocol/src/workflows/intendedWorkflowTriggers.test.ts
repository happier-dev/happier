import { describe, expect, it } from 'vitest';
import { WorkflowDefinitionCreateRequestV1Schema, WorkflowDefinitionUpdateRequestV1Schema } from './actionsV1.js';

describe('intended trigger save requests', () => {
  it('admits pending Event declaration locators and saved identities without accepting authored schemas', () => {
    const eventRef = { pluginId: 'com.acme.events', localId: 'pull-request' };
    const intendedTriggers = [{ kind: 'pluginEvent', eventRef, observationTransport: {
      kind: 'checkpointedPull', watcherMaterializationRef: {
        machineId: 'machine', pluginId: eventRef.pluginId, materializationId: 'materialization',
      },
    } }, { kind: 'pluginEvent', automationId: 'saved-set', triggerId: 'saved-trigger', eventRef }];
    const create = { definitionId: '11111111-1111-4111-8111-111111111111', definition: { blocks: ['Review'] },
      metadata: { title: 'Review' }, intendedTriggers };
    expect(WorkflowDefinitionCreateRequestV1Schema.parse(create)).toEqual(create);
    const update = { ...create, expectedRevision: { headerVersion: 1, bodyVersion: 1 } };
    expect(WorkflowDefinitionUpdateRequestV1Schema.parse(update)).toEqual(update);
    expect(WorkflowDefinitionCreateRequestV1Schema.safeParse({ ...create, intendedTriggers: [
      { ...intendedTriggers[0], payloadSchema: { type: 'number' } },
    ] }).success).toBe(false);
    expect(WorkflowDefinitionCreateRequestV1Schema.parse({ ...create, intendedTriggers: [] }).intendedTriggers).toEqual([]);
  });
});
