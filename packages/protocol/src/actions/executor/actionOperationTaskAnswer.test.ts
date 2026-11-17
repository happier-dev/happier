import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from '../actionIds.js';
import { getActionSpec } from '../actionSpecs.js';
import { projectApprovalReviewInput } from '../actionApprovalPresentation.js';
import { readActionSecretInputPaths } from '../actionInputHintsRuntime.js';
import { ActionOperationActionIdV1Schema } from '../specs/actionOperations.js';
import { ActionOperationSnapshotV1Schema } from '../operations/v1.js';
import { executeActionOperationActionV1, type ActionOperationMachineTransportV1 } from './actionOperationActions.js';

const address = { serverId: 'home', machineId: 'machine', operationId: 'setup' };
const prompt = { kind: 'sudo.password' as const, adminUsername: 'operator' };
const question = { taskId: 'private-task', prompt };
const operation = ActionOperationSnapshotV1Schema.parse({
  version: 1, operationId: address.operationId, revision: 2, actionId: 'machines.setup.apply', state: 'running',
  scope: { accountId: 'account', machineId: address.machineId }, title: 'Setup', createdAt: 1,
  startedAt: 1, cancellation: 'supported', domainRef: { kind: 'machineSetup', serverId: address.serverId, machineId: address.machineId,
    setupTask: { id: question.taskId, taskKind: 'machine.setup.apply.v1', prompt } },
});

function input() {
  return getActionSpec(ActionIdSchema.parse('action.operations.task.respond')).inputSchema.parse({
    ...address, ...question, answer: { password: 'one-use-private-password' },
  });
}

describe('private operation task answer', () => {
  it('reads the incumbent private operation through the authenticated boundary', async () => {
    const transport: ActionOperationMachineTransportV1 = async request => {
      expect(request.method).toBe('actionOperation.get.v2');
      return { kind: 'found', operation };
    };
    expect(await executeActionOperationActionV1({
      actionId: 'action.operations.get', input: address, transport,
    })).toMatchObject({ kind: 'found', operation: { operationId: address.operationId, state: 'running' } });
  });

  it('answers the current operation question through the incumbent private task response transport', async () => {
    const sent: unknown[] = [];
    const transport: ActionOperationMachineTransportV1 = async request => {
      if (request.method === 'actionOperation.get.v2') return { kind: 'found', operation };
      sent.push(request.payload);
      return { ok: true, result: null };
    };
    const result = await executeActionOperationActionV1({
      actionId: ActionOperationActionIdV1Schema.parse('action.operations.task.respond'), input: input(), transport,
      context: { surface: 'ui', expectedAccountId: 'account' },
    });
    expect(result).toEqual({ kind: 'answered' });
    expect(sent).toEqual([{ id: 'tool.systemTasks', method: 'respond', params: {
      taskId: question.taskId, expectedPromptKind: prompt.kind, answer: { password: 'one-use-private-password' },
    } }]);
    expect(JSON.stringify(result)).not.toContain('one-use-private-password');
  });

  it('refuses stale, settled and cross-account or machine questions before disclosing the answer', async () => {
    const changed = [
      { ...operation, state: 'cancelled', settledAt: 3 },
      { ...operation, scope: { ...operation.scope, accountId: 'other-account' } },
      { ...operation, scope: { ...operation.scope, machineId: 'other-machine' } },
      { ...operation, operationId: 'other-operation' },
      { ...operation, domainRef: { ...operation.domainRef, serverId: 'other-home' } },
      { ...operation, domainRef: { ...operation.domainRef, setupTask: {
        id: 'later-task', taskKind: 'machine.setup.apply.v1', prompt,
      } } },
      { ...operation, domainRef: { ...operation.domainRef, setupTask: {
        id: question.taskId, taskKind: 'machine.setup.apply.v1', prompt: { ...prompt, adminUsername: 'another-operator' },
      } } },
    ];
    for (const current of changed) {
      const sent: unknown[] = [];
      const transport: ActionOperationMachineTransportV1 = async request => {
        if (request.method === 'actionOperation.get.v2') return { kind: 'found', operation: current };
        sent.push(request.payload);
        return { ok: true, result: null };
      };
      expect(await executeActionOperationActionV1({
        actionId: ActionOperationActionIdV1Schema.parse('action.operations.task.respond'), input: input(), transport,
        context: { surface: 'ui', expectedAccountId: 'account' },
      })).toMatchObject({ ok: false, errorCode: 'action_operation_unavailable' });
      expect(sent).toEqual([]);
    }
  });

  it('withholds the answer when the host has no captured Account', async () => {
    const sent: unknown[] = [];
    const result = await executeActionOperationActionV1({
      actionId: ActionOperationActionIdV1Schema.parse('action.operations.task.respond'), input: input(),
      transport: async request => { sent.push(request.payload); return { kind: 'found', operation }; },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'action_operation_unavailable' });
    expect(sent).toEqual([]);
  });

  it('retains only the question identity in approvals and history', () => {
    const spec = getActionSpec(ActionIdSchema.parse('action.operations.task.respond'));
    expect(spec.approvalInputCustody).toBe('live_only');
    expect(spec.sideEffectClass).toBe('write');
    expect(spec.safety).toBe('danger');
    expect(readActionSecretInputPaths(spec, input())).toEqual(['answer.password']);
    const observation = spec.projectObservationInput?.(input());
    expect(observation).toMatchObject({ ...address, ...question });
    expect(observation).not.toHaveProperty('answer');
    const review = projectApprovalReviewInput(spec, input());
    expect(review).toMatchObject({ ...address, ...question });
    expect(JSON.stringify(review)).not.toContain('one-use-private-password');
  });

  it('returns only the typed response failure when a private answer loses its prompt', async () => {
    const transport: ActionOperationMachineTransportV1 = async request => request.method === 'actionOperation.get.v2'
      ? { kind: 'found', operation }
      : { ok: false, error: { code: 'no_prompt', message: 'one-use-private-password' } };
    const result = await executeActionOperationActionV1({
      actionId: ActionOperationActionIdV1Schema.parse('action.operations.task.respond'), input: input(), transport,
      context: { surface: 'ui', expectedAccountId: 'account' },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'no_prompt' });
    expect(JSON.stringify(result)).not.toContain('one-use-private-password');
  });

  it('permits a visible retry after a transient task response failure', async () => {
    let attempts = 0;
    const transport: ActionOperationMachineTransportV1 = async request => {
      if (request.method === 'actionOperation.get.v2') return { kind: 'found', operation };
      attempts += 1;
      return attempts === 1
        ? { ok: false, error: { code: 'task_unavailable', message: 'Private task transport unavailable' } }
        : { ok: true, result: null };
    };
    const execute = () => executeActionOperationActionV1({
      actionId: ActionOperationActionIdV1Schema.parse('action.operations.task.respond'), input: input(), transport,
      context: { surface: 'ui', expectedAccountId: 'account' },
    });
    expect(await execute()).toMatchObject({ ok: false, errorCode: 'task_unavailable' });
    expect(await execute()).toEqual({ kind: 'answered' });
  });
});
