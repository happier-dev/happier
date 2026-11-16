import { describe, expect, it } from 'vitest';
import { WorkflowValueReferenceSchema } from './workflowReferenceV1.js';
import { validateWorkflowDefinition } from './workflowValidationV1.js';
import { materializeWorkflowAcceptedSnapshotV1 } from './materializeWorkflowAcceptedSnapshotV1.js';

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
  it('accepts the qualified Event and path arm', () => {
    expect(WorkflowValueReferenceSchema.safeParse({ kind: 'trigger_event', event, path: ['number'] }).success).toBe(true);
  });
  it.each([{ triggerEvents: [] }, { triggerEvents: [{ event, payloadSchema: null }] }])('reports an absent Event declaration as missing_reference', ({ triggerEvents }) => {
    const checked = validateWorkflowDefinition(definition(['number']), { triggerEvents });
    expect(checked.issues).toContainEqual(expect.objectContaining({ code: 'missing_reference', severity: 'warning' }));
    expect(checked.valid).toBe(true);
  });
  it.each([['repository'], ['labels']])('rejects a non-scalar path %s', (field) => {
    expect(validateWorkflowDefinition(definition([field]), { triggerEvents: [{ event, payloadSchema }] }).issues)
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
