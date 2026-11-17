import { describe, expect, it } from 'vitest';
import type { ActionResolvedSessionTargetsV1 } from '../sessionTargetV1.js';
import { createActionExecutor } from '../actionExecutor.js';
import { bindActionSessionTargetOperands, projectChildActionSessionTargetsV1, registerHostSelectedActionSessionAddressV1, resolveActionSessionTargets, validateActionSessionAddressV1, validateContributedActionSessionAddressV1 } from './sessionTargets.js';

describe('exact Action Session address binding', () => {
  it('rejects a shorthand even when the raw operand equals the proposed exact id', () => {
    expect(validateActionSessionAddressV1({ sessionTarget: { field: 'sessionId', cardinality: 'one' },
      input: { sessionId: 'manager' }, sessionAddress: { serverId: 'reviewed-home', sessionId: 'manager' } })).toMatchObject({ ok: false });
  });
  it('binds one actual exact operand, including a fanout-capable declaration', () => {
    const sessionAddress = { serverId: 'reviewed-home', sessionId: 'reviewed' };
    expect(validateActionSessionAddressV1({ sessionTarget: { field: 'sessionId', cardinality: 'many' },
      input: { sessionId: 'reviewed' }, sessionAddress })).toEqual({ ok: true, sessionAddress });
  });
  it.each([
    { sessionTarget: undefined, input: {} },
    { sessionTarget: { field: 'sessionId', cardinality: 'one' as const }, input: { sessionId: 'another' } },
    { sessionTarget: { field: 'sessionId', cardinality: 'many' as const }, input: { sessionId: { selector: 'workers' } } },
    { sessionTarget: { field: 'sessionId', cardinality: 'one' as const }, input: { sessionId: 'manager' } },
    { sessionTarget: { field: 'targets.*.sessionId', cardinality: 'one' as const }, input: { targets: [{ sessionId: 'reviewed' }, { sessionId: 'another' }] } },
  ])('refuses a missing, mismatched or non-single exact operand', ({ sessionTarget, input }) => {
    expect(validateActionSessionAddressV1({ sessionTarget, input,
      sessionAddress: { serverId: 'reviewed-home', sessionId: 'reviewed' } })).toMatchObject({ ok: false });
  });
});

describe('child Action exact Session address projection', () => {
  const parent: ActionResolvedSessionTargetsV1 = { actionId: 'review.apply', field: 'sessionId',
    targets: [{ serverId: 'home', sessionId: 'reviewed' }], selector: false };
  const declaration = { field: 'sessionId', cardinality: 'many' as const };

  it.each([
    { name: 'another Session', input: { sessionId: 'another', message: 'verify' }, snapshot: parent, sameHome: true },
    { name: 'another Home', input: { sessionId: 'reviewed', message: 'verify' }, snapshot: parent, sameHome: false },
    { name: 'an unrelated parent', input: { sessionId: 'reviewed', message: 'verify' },
      snapshot: { ...parent, actionId: 'session.role.set' }, sameHome: true },
    { name: 'a group without an exact parent leaf', input: { sessionId: 'reviewed', message: 'verify' },
      snapshot: { ...parent, targets: [...parent.targets, { serverId: 'home', sessionId: 'another' }] }, sameHome: true },
    { name: 'new selector intent', input: { sessionId: { selector: 'self' }, message: 'verify' }, snapshot: parent, sameHome: true },
  ])('refuses $name before the message transport', async ({ input, snapshot, sameHome }) => {
    let effects = 0;
    const sessionTargetsV1 = projectChildActionSessionTargetsV1({ parentActionId: 'review.apply',
      actionId: 'session.message.send', input, declaration, snapshot, sameHome });
    const executor = createActionExecutor({ sessionSendMessage: async () => {
      effects += 1; return { status: 'accepted', localId: 'message' };
    } });
    expect(await executor.execute('session.message.send', input, { surface: 'ui',
      serverId: sameHome ? 'home' : 'foreign-home', sessionTargetsV1 }))
      .toMatchObject({ ok: false, errorCode: 'approval_stale' });
    expect(effects).toBe(0);
  });

  it('preserves a child-owned address rather than replacing it with the parent address', async () => {
    const input = { sessionId: 'child-owned', message: 'verify' };
    const snapshot = { ...parent, actionId: 'session.message.send',
      targets: [{ serverId: 'home', sessionId: input.sessionId }] };
    const sessionTargetsV1 = projectChildActionSessionTargetsV1({ parentActionId: 'review.apply',
      actionId: 'session.message.send', input, declaration, snapshot, sameHome: true });
    const effects: string[] = [];
    const executor = createActionExecutor({ sessionSendMessage: async ({ sessionId }) => {
      effects.push(sessionId); return { status: 'accepted', localId: 'message' };
    } });
    expect(await executor.execute('session.message.send', input, { surface: 'ui', serverId: 'home', sessionTargetsV1 }))
      .toMatchObject({ ok: true });
    expect(effects).toEqual(['child-owned']);
  });

  it('binds the actual single collection operand through the existing slot owner', () => {
    const input = { participants: [{ sessionId: 'reviewed' }] };
    const childDeclaration = { field: 'participants.*.sessionId', cardinality: 'one' as const };
    const snapshot = projectChildActionSessionTargetsV1({ parentActionId: 'review.apply', actionId: 'discussion.create',
      input, declaration: childDeclaration, snapshot: parent, sameHome: true });
    expect(snapshot?.operands).toEqual([{ field: 'participants.0.sessionId', target: parent.targets[0] }]);
    expect(bindActionSessionTargetOperands(input, snapshot!, childDeclaration, true)).toEqual(input);
    expect(bindActionSessionTargetOperands({ participants: [{ sessionId: 'another' }] }, snapshot!, childDeclaration, true)).toBeNull();
  });
});

// An exact routing constraint cannot turn plugin-authored selector intent into a picked target.
describe('host-selected exact contributed target', () => {
  it('refuses selector intent even when it resolves to the picked Session', async () => {
    const result = await resolveActionSessionTargets({}, {
      actionId: 'action.invoke', declaration: { field: 'input.sessionId', cardinality: 'one' },
      input: { input: { sessionId: { selector: 'self' } } },
      context: { surface: 'plugin', authority: 'account_automation', serverId: 'home', defaultSessionId: 'picked',
        expectedSessionAddress: { serverId: 'home', sessionId: 'picked' } },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'session_address_mismatch' });
  });
});

describe('contributed Session address custody', () => {
  it('accepts a host-picked tuple only for its captured Account and plugin', () => {
    const selectionScope = {};
    const sessionAddress = { serverId: 'home', sessionId: 'picked' };
    registerHostSelectedActionSessionAddressV1(selectionScope, 'plugin-a', sessionAddress);
    expect(validateContributedActionSessionAddressV1({ selectionScope, callerPluginId: 'plugin-a',
      sessionAddress: JSON.parse(JSON.stringify(sessionAddress)) })).toEqual({ ok: true, sessionAddress });
    for (const candidate of [
      { selectionScope: {}, callerPluginId: 'plugin-a', sessionAddress },
      { selectionScope, callerPluginId: 'plugin-b', sessionAddress },
      { selectionScope, callerPluginId: 'plugin-a', sessionAddress: { ...sessionAddress, sessionId: 'fabricated' } },
    ]) expect(validateContributedActionSessionAddressV1(candidate)).toMatchObject({ ok: false });
  });

  it('inherits only one exact host-admitted target, without reusing its operand declaration', () => {
    const sessionAddress = { serverId: 'home', sessionId: 'picked' };
    const admittedSessionTargets: ActionResolvedSessionTargetsV1 = { actionId: 'session.message.send', field: 'sessionId',
      targets: [sessionAddress], selector: false };
    expect(validateContributedActionSessionAddressV1({ admittedSessionTargets, sessionAddress }))
      .toEqual({ ok: true, sessionAddress });
    expect(validateContributedActionSessionAddressV1({ admittedSessionTargets,
      sessionAddress: { ...sessionAddress, serverId: 'foreign-home' } })).toMatchObject({ ok: false });
    expect(validateContributedActionSessionAddressV1({ admittedSessionTargets: { ...admittedSessionTargets,
      targets: [sessionAddress, { serverId: 'home', sessionId: 'other' }] }, sessionAddress })).toMatchObject({ ok: false });
  });
});

it('rejects an exact routing option on an Action without a declared Session operand before effects', async () => {
  let effects = 0;
  const executor = createActionExecutor({ sessionList: async () => {
    effects += 1; return { sessions: [], nextCursor: null, hasNext: false };
  } });
  const result = await executor.execute('session.list', {}, { surface: 'ui', authority: 'present_user',
    actionCaller: { kind: 'host' }, serverId: 'home', expectedSessionAddress: { serverId: 'home', sessionId: 'picked' } });
  expect(result).toMatchObject({ ok: false, errorCode: 'session_address_unsupported' });
  expect(effects).toBe(0);
});
