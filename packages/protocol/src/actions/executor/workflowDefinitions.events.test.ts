import { describe, expect, it } from 'vitest';
import { WorkflowDefinitionV1Schema } from '../../workflows/workflowV1.js';
import type { PluginJsonSchemaV2 } from '../../plugins/contributions/jsonSchema.js';
import { createWorkflowActionExecutor } from './workflowAccountActions.js';
import { createWorkflowDefinitionActions, type WorkflowDefinitionArtifactOperations } from './workflowDefinitions.js';
import { createWorkflowTriggerActions } from './workflowTriggerActions.js';
import { AutomationTriggerDetailSchema } from '../../automations/automationTriggerProjectionV1.js';
import type { AutomationDefinitionDetail } from '../../automations/automationApiV3.js';

const definitionId = '11111111-1111-4111-8111-111111111111';
const revision = { headerVersion: 1, bodyVersion: 1 };
const metadata = { title: 'Event review' };
const event = { pluginId: 'com.acme.events', localId: 'pull-request' };
const intendedTriggers = [{ kind: 'pluginEvent', eventRef: event, observationTransport: {
  kind: 'checkpointedPull', watcherMaterializationRef: {
    machineId: 'machine', pluginId: event.pluginId, materializationId: 'materialization',
  },
} }];
const payloadSchema: PluginJsonSchemaV2 = { type: 'object', properties: {
  number: { type: 'number' }, repository: { type: 'object', properties: { name: { type: 'string' } } },
} };

function definition(path: readonly string[] = ['number']) {
  return { version: 1, defaults: {
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
  }, blocks: [{ kind: 'step', id: 'review', document: { text: 'Review the Event', references: [], attachments: [] },
    input: [{ kind: 'trigger_event', event, path }], result: { kind: 'text' } }] };
}

function harness(initial?: unknown) {
  let stored = initial;
  let writes = 0;
  let declarationReads = 0;
  let storedEvents = initial !== undefined;
  // Artifact persistence and Automation network operations are the system boundaries.
  const artifactStore: WorkflowDefinitionArtifactOperations = {
    read: async () => stored === undefined ? null : { artifactId: definitionId, revision, ownerAccountId: 'owner', access: 'owner',
      header: { kind: 'workflow-definition.v1', definitionId, revision, metadata },
      body: JSON.stringify({ kind: 'workflow-definition.v1', definition: stored }) },
    list: async () => ({ items: [] }),
    create: async input => { writes += 1; stored = JSON.parse(input.body).definition; },
    update: async input => { writes += 1; stored = JSON.parse(input.body).definition;
      return { ok: true, revision: { headerVersion: 2, bodyVersion: 2 } }; },
    delete: async () => ({ ok: true }),
  };
  const unused = (): never => { throw new Error('unexpected_run'); };
  const savedSet: AutomationDefinitionDetail = { id: 'saved-set', workflowDefinitionId: definitionId,
    scopeSessionId: null, name: 'Event review', description: null, enabled: true, targetType: null,
    existingSessionId: null, templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1,
    assignments: [], scheduleOccurrences: [], templateCiphertext: 'retained-private-content',
    triggers: [AutomationTriggerDetailSchema.parse({
      kind: 'pluginEvent', id: 'saved-trigger', revision: 1, enabled: false, createdAt: 1, updatedAt: 1,
      eventRef: event, sourceSelectorId: '00000000-0000-4000-8000-000000000001', sourceContractVersion: 1,
      observation: { kind: 'checkpointedPull', watcher: null }, sourceStatus: null, sourceCatalogStatus: null,
      triggerDefinitionEnvelope: '{}', payloadSchema,
    })] };
  const triggers = createWorkflowTriggerActions({
    newId: unused, openContext: unused, sealContext: unused, resolveWorkflow: unused,
    automations: {
      list: unused, get: unused, create: unused, reconcile: unused, delete: unused,
      listDetails: async () => { declarationReads += 1;
        return { automations: storedEvents ? [savedSet] : [], nextCursor: null }; },
      readTriggerEventDeclarations: async () => { declarationReads += 1;
        return { triggerEvents: [{ event, payloadSchema }] }; },
    },
  });
  const definitions = createWorkflowDefinitionActions({ artifactStore, encodeListCursor: () => '',
    readWorkflowTriggerEvents: triggers.readWorkflowTriggerEvents,
  });
  const execute = createWorkflowActionExecutor({ isWorkflowFeatureEnabled: () => true, definitions, runs: { execute: unused } });
  return { definitions, execute, stored: () => stored, writes: () => writes, declarationReads: () => declarationReads,
    removeStoredEvents: () => { storedEvents = false; } };
}

describe('Workflow Event references at the save boundary', () => {
  it('creates the first definition against intended Event triggers before they are enrolled', async () => {
    const kit = harness();
    const result = await kit.execute({ actionId: 'workflow.definition.create', input: {
      definitionId, definition: definition(), metadata, intendedTriggers,
    }, context: { surface: 'ui' } });
    expect(result).toMatchObject({ definitionId, definition: definition() });
    expect(kit.writes()).toBe(1);
    expect(kit.declarationReads()).toBe(1);
  });

  it.each([true, false])('validates new Event paths before updating (intended list provided: %s)', async intended => {
    const kit = harness(definition());
    const result = await kit.execute({ actionId: 'workflow.definition.update', input: {
      definitionId, expectedRevision: revision, definition: definition(['repository']), metadata,
      ...(intended ? { intendedTriggers } : {}),
    }, context: { surface: 'ui' } });
    expect(result).toMatchObject({ ok: false, errorCode: 'invalid_input', details: {
      issues: [expect.objectContaining({ code: 'invalid_input', severity: 'error' })],
    } });
    expect(kit.writes()).toBe(0);
    expect(kit.declarationReads()).toBe(1);
  });

  it('saves a copy with no triggers and keeps it readable after the original Event disappears', async () => {
    const kit = harness();
    const result = await kit.execute({ actionId: 'workflow.definition.create', input: {
      definitionId, definition: definition(['repository']), metadata, intendedTriggers: [],
    }, context: { surface: 'ui' } });
    expect(result).toMatchObject({ definitionId, definition: definition(['repository']) });
    kit.removeStoredEvents();
    expect(await kit.definitions.get({ definitionId })).toMatchObject({ definition: definition(['repository']) });
    expect(kit.declarationReads()).toBe(0);
  });

  it('does not read Event declarations for a definition without Event references', async () => {
    const ordinary = WorkflowDefinitionV1Schema.parse({ version: 1, blocks: [{ kind: 'wait', id: 'review',
      document: { text: 'Review', references: [], attachments: [] } }] });
    const kit = harness();
    expect(await kit.execute({ actionId: 'workflow.definition.create', input: {
      definitionId, definition: ordinary, metadata,
    }, context: { surface: 'ui' } })).toMatchObject({ definitionId });
    expect(kit.declarationReads()).toBe(0);
  });

  it('validates edited definitions through the same saved Event declaration owner', async () => {
    const kit = harness(definition(['repository']));
    await expect(kit.definitions.edit({ definitionId, expectedRevision: revision,
      ops: [{ kind: 'rename', name: 'Renamed' }] }, undefined, { surface: 'ui' })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(kit.writes()).toBe(0);
    expect(kit.declarationReads()).toBe(1);
  });
});
