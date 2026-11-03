import { describe, expect, it } from 'vitest';
import { validateActionSessionAddressV1 } from './sessionTargets.js';

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
