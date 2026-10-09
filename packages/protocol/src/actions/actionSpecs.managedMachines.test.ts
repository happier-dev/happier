import { describe, expect, it } from 'vitest';

import { ACTION_IDS } from './actionIds.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { getActionSpec, listActionCliCommandDeclarations, PLUGIN_INVOCABLE_ACTION_IDS, PUBLIC_ACTION_IDS, resolveActionExecutionPlacementForInput } from './actionSpecs.js';

const reads = ['machines.provisioners.list', 'machines.provisioners.check', 'machines.provisioners.options',
  'machines.managed.list', 'machines.managed.get', 'machines.managed.inspect'] as const;
const effects = ['machines.managed.acquire', 'machines.managed.bootstrap.retry', 'machines.managed.cancel',
  'machines.managed.power.set', 'machines.managed.retention.update', 'machines.managed.delete',
  'machines.managed.controller.update', 'machines.managed.retire'] as const;

describe('managed Machine host Action contracts', () => {
  it('requires approval before applying the exact preset environment on an existing machine', () => {
    const spec = getActionSpec('machines.environment.apply');
    const input = { homeId: 'home', machineId: 'guest', presetId: 'preset', presetRevision: 4 };
    expect(spec.inputSchema.parse(input)).toEqual(input);
    expect(spec.inputSchema.safeParse({ ...input, environment: { setupScript: 'unreviewed' } }).success).toBe(false);
    expect(spec).toMatchObject({ safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'machine',
      surfaces: { ui: true, cli: true, agent: true, mcp: true }, operation: { version: 1, visibility: 'activity' } });
    expect(resolveActionApprovalRouting({ actionId: 'machines.environment.apply', spec, input,
      context: { surface: 'agent' } }).required).toBe(true);
  });
  it('makes skipping setup an explicit confirmed mutation of the same creation row', () => {
    const spec = getActionSpec('machines.managed.setup.skip');
    expect(spec.inputSchema.parse({ homeId: 'home', managedId: 'paid', expectedIntentRevision: 4 }))
      .toEqual({ homeId: 'home', managedId: 'paid', expectedIntentRevision: 4 });
    expect(spec).toMatchObject({ executionPlacement: 'account', sideEffectClass: 'danger' });
    expect(resolveActionApprovalRouting({ actionId: 'machines.managed.setup.skip', spec,
      context: { surface: 'agent' } }).required).toBe(true);
  });
  it('accepts known-offline creation without manufacturing a daemon operation', () => {
    const output = getActionSpec('machines.managed.acquire').outputSchema;
    expect(output.parse({ managedId: 'waiting' })).toEqual({ managedId: 'waiting' });
    expect(output.parse({ managedId: 'running', operation: { operationId: 'real-daemon-operation' } }))
      .toEqual({ managedId: 'running', operation: { operationId: 'real-daemon-operation' } });
    expect(output.safeParse({ operation: { operationId: 'fake-operation' } }).success).toBe(false);
  });
  it('places admitted-creation cancellation on the Account without losing its danger or operation contract', () => {
    const spec = getActionSpec('machines.managed.cancel');
    const input = spec.inputSchema.parse({ homeId: 'home', managedId: 'waiting', expectedIntentRevision: 0 });
    expect(resolveActionExecutionPlacementForInput(spec, input)).toBe('account');
    expect(spec).toMatchObject({ safety: 'danger', sideEffectClass: 'danger',
      operation: { version: 1, visibility: 'activity', progress: 'reported' },
      serverTransport: { method: 'POST', path: '/v1/machines/managed/actions/cancel' },
    });
    expect(resolveActionApprovalRouting({ actionId: 'machines.managed.cancel', spec, input,
      context: { surface: 'ui', authority: 'present_user' },
    })).toMatchObject({ required: true, flow: 'deferred' });
  });
  it('requires immediate currentness and permits only selected deferred stop/delete inputs', () => {
    const power = getActionSpec('machines.managed.power.set').inputSchema;
    const target = { homeId: 'home', managedId: 'retained' };
    expect(power.safeParse({ ...target, when: 'now', intent: 'stop' }).success).toBe(false);
    expect(power.safeParse({ ...target, when: 'now', expectedRevision: 2, intent: 'stop', afterMs: 1 }).success).toBe(false);
    expect(power.safeParse({ ...target, when: 'after-idle', intent: 'start' }).success).toBe(false);
    expect(power.safeParse({ ...target, when: 'after-idle', intent: 'stop', afterMs: 0 }).success).toBe(false);
    expect(power.safeParse({ ...target, when: 'after-idle', intent: 'stop', afterMs: 17 }).success).toBe(true);
    const deletion = getActionSpec('machines.managed.delete').inputSchema;
    expect(deletion.safeParse({ ...target, when: 'after-idle', intent: 'delete', reviewedDependencies: true }).success).toBe(true);
    expect(deletion.safeParse({ ...target, when: 'after-idle', intent: 'stop', reviewedDependencies: true }).success).toBe(false);
  });
  it('admits reviewed managed-resource disposition only on Account deletion', () => {
    const input = { accountId: 'account', managedResourceDispositions: [{ managedId: 'retained', expectedIntentRevision: 2, expectedAllocation: 'may-exist', responsibility: 'manual' }] };
    expect(getActionSpec('home.accounts.delete').inputSchema.safeParse(input).success).toBe(true);
    expect(getActionSpec('home.accounts.disable').inputSchema.safeParse(input).success).toBe(false);
  });
  it('exposes discovery, recovery and reviewed creation through the canonical headless surfaces', () => {
    const commands = new Map(listActionCliCommandDeclarations().map(({ spec, binding }) => [spec.id, binding.path]));
    for (const actionId of [...reads, ...effects]) {
      expect(ACTION_IDS).toContain(actionId);
      expect(PUBLIC_ACTION_IDS).toContain(actionId);
      expect(PLUGIN_INVOCABLE_ACTION_IDS).toContain(actionId);
      expect(getActionSpec(actionId)).toMatchObject({
        surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: true, rpc: true },
        bindings: { rpcMethod: actionId },
        executionPlacement: ['machines.provisioners.list', 'machines.managed.list', 'machines.managed.get', 'machines.managed.cancel'].includes(actionId)
          ? 'account' : 'machine',
      });
      expect(commands.get(actionId)).toEqual(actionId.split('.'));
    }
    for (const actionId of reads) expect(getActionSpec(actionId).sideEffectClass).toBe('read');
    for (const actionId of effects) {
      const spec = getActionSpec(actionId);
      expect(spec).toMatchObject({ safety: 'danger', sideEffectClass: 'danger', operation: {
        version: 1, visibility: 'activity', progress: 'reported',
      } });
      expect(resolveActionApprovalRouting({ actionId, spec, context: { surface: 'agent' } }).required).toBe(true);
    }
  });
});
