import { expect, it } from 'vitest';
import { getActionSpec, projectExternalActionMachineRuntimeDemandV1, readExternalActionMachineRuntimeDemandV1 } from './actionSpecs.js';
import { sealExternalActionRequestV2 } from './externalActionEncryption.js';
import type { ActionExecutorContext } from './executor/types.js';

const context: ActionExecutorContext = { serverId: 'home', defaultSessionId: 'current',
  externalActionTarget: { kind: 'machine', machineId: 'guest' }, executionRunTargetMachineId: 'guest' };

it('declares explicit Send-now as finite runtime demand while ordinary and enqueued input retain accepted activation', () => {
  const target = { kind: 'session' as const, sessionId: 'selected' };
  for (const kind of [undefined, 'enqueue', 'send_now'] as const) {
    const input = { sessionId: target.sessionId, message: 'hello', ...(kind ? { requestedAction: { v: 1, kind } } : {}) };
    const demand = getActionSpec('session.message.send').machineRuntimeDemandForInput?.(input, context);
    expect(demand).toEqual({ target, serverId: 'home', ...(kind === 'send_now' ? {} : { activation: 'accepted-input' }) });
    const envelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
      binding: { serverIdentityId: 'srv_home', accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 },
        actionId: 'session.message.send', requestId: 'send-now', target }, input,
      material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(7) }, randomBytes: size => new Uint8Array(size).fill(5) });
    expect(readExternalActionMachineRuntimeDemandV1('session.message.send', envelope)).toBe(kind === 'send_now' ? 'required' : undefined);
  }
});

it('classifies explicit runtime work at its original Action declaration and keeps detached run scope exact', () => {
  const session = { target: { kind: 'session', sessionId: 'selected' }, serverId: 'home' };
  expect(getActionSpec('session.message.send').machineRuntimeDemandForInput?.({ sessionId: 'selected' }, context))
    .toEqual({ ...session, activation: 'accepted-input' });
  expect(getActionSpec('session.open').machineRuntimeDemandForInput?.({ sessionId: 'selected', intent: 'resume' }, context)).toEqual(session);
  expect(getActionSpec('execution.run.start').machineRuntimeDemandForInput?.({ sessionId: 'selected' }, context)).toEqual(session);
  expect(getActionSpec('execution.run.start').machineRuntimeDemandForInput?.({}, context))
    .toEqual({ ...session, target: { kind: 'session', sessionId: 'current' } });
  const machine = { target: { kind: 'machine', machineId: 'guest' }, serverId: 'home' };
  expect(getActionSpec('execution.run.start').machineRuntimeDemandForInput?.({ sessionId: null }, context)).toEqual(machine);
  expect(getActionSpec('session.spawn_new').machineRuntimeDemandForInput?.({ executionTarget: { serverId: 'home', machineId: 'guest' } }, context)).toEqual(machine);
  expect(getActionSpec('machines.terminal.open').machineRuntimeDemandForInput?.({ serverId: 'home', machineId: 'guest' }, context)).toEqual(machine);
  expect(getActionSpec('machines.terminal.restart').machineRuntimeDemandForInput?.({ serverId: 'home', machineId: 'guest' }, context)).toEqual(machine);
  expect(getActionSpec('daemon.filesystem.readFile').machineRuntimeDemandForInput?.({}, context)).toEqual(machine);
});

it('does not turn Session navigation, terminal observation or passive file discovery into runtime demand', () => {
  expect(getActionSpec('session.message.send').machineRuntimeDemandForInput?.({ sessionId: { selector: 'workers' } }, context)).toBeNull();
  expect(getActionSpec('session.open').machineRuntimeDemandForInput?.({ sessionId: 'selected' }, context) ?? null).toBeNull();
  expect(getActionSpec('machines.terminal.list').machineRuntimeDemandForInput?.({}, context) ?? null).toBeNull();
  expect(getActionSpec('machines.terminal.read').machineRuntimeDemandForInput?.({}, context) ?? null).toBeNull();
  expect(getActionSpec('daemon.filesystem.listDirectory').machineRuntimeDemandForInput?.({}, context) ?? null).toBeNull();
  expect(getActionSpec('execution.run.list').machineRuntimeDemandForInput?.({}, context) ?? null).toBeNull();
});

it('demands the explicit Sync controller for flush while passive relationship reads stay asleep', () => {
  expect(getActionSpec('workspace.sync.relationship.flush').machineRuntimeDemandForInput?.(
    { controllerMachineId: 'sync-controller', relationshipId: 'link' }, context))
    .toEqual({ target: { kind: 'machine', machineId: 'sync-controller' }, serverId: 'home' });
  expect(getActionSpec('workspace.sync.relationships.list').machineRuntimeDemandForInput?.({}, context) ?? null).toBeNull();
});

it('keeps auxiliary run starts on the same exact Session or explicitly detached Machine', () => {
  const session = { target: { kind: 'session', sessionId: 'selected' }, serverId: 'home' };
  for (const actionId of ['execution.run.ensure_or_start', 'execution.run.stream.start', 'subagents.plan.start',
    'subagents.delegate.start', 'voice_agent.start', 'review.start'] as const) {
    expect(getActionSpec(actionId).machineRuntimeDemandForInput?.({ sessionId: 'selected' }, context), actionId).toEqual(session);
  }
  const detached = { target: { kind: 'machine', machineId: 'guest' }, serverId: 'home' };
  expect(getActionSpec('subagents.plan.start').machineRuntimeDemandForInput?.({ target: { kind: 'detached' } }, context)).toEqual(detached);
  expect(getActionSpec('review.start').machineRuntimeDemandForInput?.({ target: { kind: 'detached' } }, context)).toEqual(detached);
});
