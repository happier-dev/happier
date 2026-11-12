import { describe, expect, it } from 'vitest';
import type { ActionResolvedSessionTargetsV1 } from '../sessionTargetV1.js';
import { createActionExecutor } from '../actionExecutor.js';
import { registerHostSelectedActionSessionAddressV1, resolveActionSessionTargets, validateActionSessionAddressV1, validateContributedActionSessionAddressV1 } from './sessionTargets.js';

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
