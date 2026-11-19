import { describe, expect, it } from 'vitest';
import { WorkflowValueReferenceSchema } from './workflowReferenceV1.js';
import { validateWorkflowDefinition } from './workflowValidationV1.js';
import { materializeWorkflowAcceptedSnapshotV1 } from './materializeWorkflowAcceptedSnapshotV1.js';
import { createWorkflowActionTriggerEventDeclarationV1, projectWorkflowActionTriggerEventOccurrenceV1, sealWorkflowTriggerEventValuesV1 } from './workflowTriggerEventReferenceV1.js';
import { WorkflowDefinitionV1Schema } from './workflowV1.js';
import { formatInlineReferenceTokenV1 } from '../runtime/input/inlineReferenceTokenV1.js';
import { MENTION_KIND_V1 } from '../runtime/input/mentionRefV1.js';
import { openWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowAcceptedSnapshotStoredEnvelopeV1 } from './workflowStoredContentV1.js';

const event = { pluginId: 'example.events', localId: 'pull-request' };
const payloadSchema = { type: 'object', properties: {
  number: { type: 'integer' }, repository: { type: 'object', properties: { name: { type: 'string' } } },
  labels: { type: 'array', items: { type: 'string' } },
} };
const definition = (path: (string | number)[]) => ({ version: 1, defaults: {}, blocks: [{
  kind: 'action', id: 'message', actionId: 'example.actions/message',
  input: { text: { kind: 'trigger_event', event, path } },
}] });
describe('trigger Event value references', () => {
  it.each(['before', 'after'] as const)('accepts the %s Action phase without a plugin identity', phase => {
    expect(WorkflowValueReferenceSchema.safeParse({ kind: 'trigger_event', event: { kind: 'action', phase },
      path: ['requestId'] }).success).toBe(true);
  });
  it.each(['before', 'after'] as const)('declares and seals only safe %s Action scalar evidence', phase => {
    const actionEvent = { kind: 'action' as const, phase };
    const authored = (path: string[]) => WorkflowDefinitionV1Schema.parse({ ...definition(path), blocks: [{
      kind: 'action', id: 'message', actionId: 'example.actions/message',
      input: { text: { kind: 'trigger_event', event: actionEvent, path } },
    }] });
    const declaration = createWorkflowActionTriggerEventDeclarationV1(phase);
    expect(validateWorkflowDefinition(authored(['requestId']), { triggerEvents: [declaration] }).issues
      .filter(issue => issue.code === 'missing_reference' || issue.code === 'invalid_input')).toEqual([]);
    expect(validateWorkflowDefinition(authored(['input']), { triggerEvents: [declaration] }).issues)
      .toContainEqual(expect.objectContaining({ code: 'invalid_input' }));
    const occurrence = projectWorkflowActionTriggerEventOccurrenceV1({ actionId: 'scm.commit.create',
      requestId: 'material-invocation', phase, ...(phase === 'after' ? { status: 'failed' as const, errorCode: 'cancelled' } : {}) });
    expect(sealWorkflowTriggerEventValuesV1([authored(['requestId'])], occurrence))
      .toEqual([{ event: actionEvent, path: ['requestId'], value: 'material-invocation' }]);
    expect(sealWorkflowTriggerEventValuesV1([authored(['requestId'])], { ...occurrence,
      event: { kind: 'action', phase: phase === 'after' ? 'before' : 'after' } })).toEqual([]);
  });
  it('accepts the qualified Event and path arm', () => {
    expect(WorkflowValueReferenceSchema.safeParse({ kind: 'trigger_event', event, path: ['number'] }).success).toBe(true);
  });
  it.each([{ triggerEvents: [] }, { triggerEvents: [{ event, payloadSchema: null }] }])('reports an absent Event declaration as missing_reference', ({ triggerEvents }) => {
    const checked = validateWorkflowDefinition(definition(['number']), { triggerEvents });
    expect(checked.issues).toContainEqual(expect.objectContaining({ code: 'missing_reference', severity: 'warning' }));
    expect(checked.valid).toBe(true);
  });
  it.each(['condition', 'text'] as const)('keeps structured Event values out of %s operands', location => {
    const reference = { kind: 'trigger_event' as const, event, path: ['repository'] };
    const mention = { kind: MENTION_KIND_V1.workflowInput, ref: 'workflowInput:0', label: 'Repository' };
    const token = formatInlineReferenceTokenV1(mention);
    const authored = WorkflowDefinitionV1Schema.parse({ version: 1, defaults: {}, blocks: [location === 'condition'
      ? { kind: 'wait', id: 'hold', document: { text: 'Wait', references: [], attachments: [] }, onlyWhen: { kind: 'exists', value: reference } }
      : { kind: 'action', id: 'message', actionId: 'example.actions/message', input: {
          text: { kind: 'text', document: { text: token, references: [{ ...mention, token }] }, input: [reference] },
        } }] });
    expect(validateWorkflowDefinition(authored, { triggerEvents: [{ event, payloadSchema }] }).issues)
      .toContainEqual(expect.objectContaining({ code: 'invalid_input' }));
    expect(sealWorkflowTriggerEventValuesV1([authored], { event, payload: { repository: { name: 'acme/widgets' } } })).toEqual([]);
  });
  it('binds an explicitly selected structured Event subtree to Action JSON without sealing sibling payloads', () => {
    const authored = WorkflowDefinitionV1Schema.parse(definition(['repository']));
    expect(validateWorkflowDefinition(authored, { triggerEvents: [{ event, payloadSchema }] }).issues
      .filter(issue => issue.code === 'invalid_input' || issue.code === 'missing_reference')).toEqual([]);
    const selected = sealWorkflowTriggerEventValuesV1([authored], { event, payload: {
      repository: { name: 'acme/widgets' }, unreferenced: { secret: 'excluded' },
    } });
    expect(selected).toEqual([{ event, path: ['repository'], value: { name: 'acme/widgets' } }]);
    const binding = { v: 1 as const, purpose: 'accepted_snapshot' as const, accountId: 'owner', runId: 'selected-event' };
    const acceptedSnapshot = { startedBy: 'trigger' as const, authoredDefinition: authored, definition: authored,
      triggerEventValues: selected, workDepth: 0, metadata: null, materializedLeaves: [], frozenChildren: {}, inputs: {},
      machineId: 'machine', executionTarget: { kind: 'session' as const },
      workspaceTarget: { project: { machineId: 'machine', directory: '/repo', checkoutRootPath: '/repo' } },
      source: { kind: 'inline' as const }, origin: { kind: 'direct' as const },
      authorization: { admittedPermissionCeiling: 'default' as const, principal: { kind: 'host' as const } } };
    const runDataKey = new Uint8Array(32).fill(7);
    for (const mode of ['plain', 'e2ee'] as const) {
      const envelope = sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ binding, acceptedSnapshot,
        ...(mode === 'plain' ? { mode } : { mode, runDataKey, randomBytes: (length: number) => new Uint8Array(length).fill(9) }) });
      if (mode === 'e2ee') expect(JSON.stringify(envelope)).not.toContain('acme/widgets');
      const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode, binding, envelope, runDataKey });
      expect(opened).toMatchObject({ kind: 'available', content: { triggerEventValues: selected } });
      expect(JSON.stringify(opened)).not.toContain('excluded');
    }
    expect(sealWorkflowTriggerEventValuesV1([authored], { event, payload: { unreferenced: 'excluded' } })).toEqual([]);
    expect(sealWorkflowTriggerEventValuesV1([authored], { event: { ...event, localId: 'another' },
      payload: { repository: { name: 'acme/widgets' } } })).toEqual([]);
    expect(validateWorkflowDefinition(definition(['unreferenced']), { triggerEvents: [{ event, payloadSchema }] }).issues)
      .toContainEqual(expect.objectContaining({ code: 'invalid_input' }));
  });
  it('accepts a declared scalar leaf of a workflow trigger', () => {
    const checked = validateWorkflowDefinition(definition(['repository', 'name']), { triggerEvents: [{ event, payloadSchema }] });
    expect(checked.issues.filter(issue => issue.code === 'missing_reference' || issue.code === 'invalid_input')).toEqual([]);
  });
});

it('seals only referenced leaves and leaves manual admission empty', async () => {
  const context = { source: { kind: 'inline' as const }, inputs: {}, machineId: 'machine', executionTarget: { kind: 'session' as const },
    workspaceTarget: { project: { machineId: 'machine', directory: '/project', checkoutRootPath: '/project' } },
    origin: { kind: 'direct' as const }, authorization: { principal: { kind: 'host' as const } } };
  const effects = { resolveTargetAvailability: async () => true };
  const authored = { version: 1, defaults: {}, blocks: [{ kind: 'wait', id: 'hold', document: { text: 'Review', references: [], attachments: [] }, onlyWhen: { kind: 'exists',
    value: { kind: 'trigger_event', event, path: ['number'] } } }] };
  const admitted = await materializeWorkflowAcceptedSnapshotV1({ definition: authored, context, effects,
    admission: { kind: 'trigger', workDepth: 0, admitLeaf: async () => { throw new Error('no agent admission expected'); },
      eventOccurrence: { event, payload: { number: 42, secret: 'unreferenced' } } } });
  expect(admitted.ok).toBe(true);
  if (!admitted.ok) throw new Error(JSON.stringify(admitted.error));
  expect(admitted.snapshot.triggerEventValues).toEqual([{ event, path: ['number'], value: 42 }]);
  const manual = await materializeWorkflowAcceptedSnapshotV1({ definition: authored, context, effects, admission: { kind: 'user' } });
  expect(manual.ok).toBe(true);
  if (!manual.ok) throw new Error(JSON.stringify(manual.error));
  expect(manual.snapshot.triggerEventValues ?? []).toEqual([]);
});
