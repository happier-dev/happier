import { describe, expect, it } from 'vitest';

import { MachineWorkSummaryV1Schema, MachineWorkSummaryGetResultV1Schema } from './machineWorkSummaryV1.js';

import { defineProtocolObject } from '../plugins/actions/protocolComposableSchema.js';

const requester = { accountId: 'bob', displayName: 'Bob', sessions: 1, tasks: 2, terminals: 1 };

describe('MachineWorkSummaryV1 privacy contract', () => {
  it('preserves optional finite load on unavailable requester inventory without fabricating requester counts', () => {
    const finiteLoad = { kind: 'known', running: 1, queued: 0, accepting: true, runAtMost: 1 } as const;
    const result = { kind: 'unavailable', finiteLoad } as const;
    const composed = defineProtocolObject({ result: MachineWorkSummaryGetResultV1Schema }, { policy: 'closed' });
    expect(MachineWorkSummaryV1Schema.safeParse(result)).toMatchObject({ success: true, data: result });
    expect(composed.parse({ result })).toEqual({ result });
    expect(MachineWorkSummaryGetResultV1Schema.parse({ ...result, finiteLoad: { kind: 'unknown' } }))
      .toEqual({ ...result, finiteLoad: { kind: 'unknown' } });
    expect(MachineWorkSummaryGetResultV1Schema.parse({ kind: 'unavailable' })).toEqual({ kind: 'unavailable' });
    for (const forbidden of [
      { ...result, requesters: [] },
      { ...result, tasks: 0 },
      { ...result, operationId: 'private-held-operation' },
      { ...result, finiteLoad: { ...finiteLoad, workspaceRefId: 'private-checkout' } },
      { kind: 'refused', code: 'access_denied', finiteLoad },
    ]) expect(MachineWorkSummaryGetResultV1Schema.safeParse(forbidden).success).toBe(false);
  });

  it('carries explicit finite load independently of broad tasks and rejects private or malformed load facts', () => {
    const finiteLoad = { kind: 'known', running: 1, queued: 2, accepting: true, runAtMost: null } as const;
    const result = { kind: 'current', requesters: [requester], finiteLoad } as const;
    const composed = defineProtocolObject({ result: MachineWorkSummaryGetResultV1Schema }, { policy: 'closed' });
    expect(MachineWorkSummaryV1Schema.safeParse(result)).toMatchObject({ success: true, data: result });
    expect(composed.parse({ result })).toEqual({ result });
    expect(MachineWorkSummaryGetResultV1Schema.parse({ ...result, finiteLoad: { kind: 'unknown' } }))
      .toEqual({ ...result, finiteLoad: { kind: 'unknown' } });
    for (const invalid of [
      { ...finiteLoad, running: -1 },
      { ...finiteLoad, queued: 0.5 },
      { ...finiteLoad, runAtMost: 0 },
      { ...finiteLoad, operationId: 'private-operation' },
      { ...finiteLoad, workspaceRefId: 'private-checkout' },
      { kind: 'unknown', running: 0 },
    ]) expect(MachineWorkSummaryGetResultV1Schema.safeParse({ ...result, finiteLoad: invalid }).success).toBe(false);
    expect(MachineWorkSummaryGetResultV1Schema.safeParse({ kind: 'refused', code: 'access_denied', finiteLoad }).success).toBe(false);
  });

  it('composes its Action result through the neutral schema contract without weakening privacy', () => {
    const schema = MachineWorkSummaryGetResultV1Schema;
    const composed = defineProtocolObject({ result: schema }, { policy: 'closed' });
    for (const result of [
      { kind: 'current', requesters: [requester] },
      { kind: 'current', requesters: [] },
      { kind: 'unavailable' },
      { kind: 'refused', code: 'access_denied' },
    ]) {
      expect(composed.parse({ result })).toEqual({ result });
      expect(schema.parse(result)).toEqual(result);
      expect(schema.nullable().parse(null)).toBeNull();
      expect(schema.safeParse({ ...result, token: 'private' }).success).toBe(false);
    }
    expect(composed.jsonSchema).toMatchObject({
      type: 'object', additionalProperties: false,
      properties: { result: expect.any(Object) },
    });
    expect(schema.safeParse({ kind: 'current', requesters: [{ ...requester, sessionId: 'private' }] }).success).toBe(false);
    expect(schema.safeParse({ kind: 'refused', code: 'invented' }).success).toBe(false);
  });

  it('preserves identities and numeric categories, including a known empty result distinct from unavailable', () => {
    const schema = MachineWorkSummaryV1Schema;
    for (const value of [
      { kind: 'current', requesters: [requester] },
      { kind: 'current', requesters: [] },
      { kind: 'unavailable' },
    ]) {
      expect(schema.safeParse(value)).toMatchObject({ success: true, data: value });
    }
    expect(schema.safeParse({ kind: 'unavailable', requesters: [] }).success).toBe(false);
    expect(schema.safeParse({ kind: 'current' }).success).toBe(false);
  });

  it('rejects content, work references and private material at both wire object boundaries', () => {
    const schema = MachineWorkSummaryV1Schema;
    for (const privateField of ['title', 'command', 'path', 'prompt', 'transcript', 'sessionId', 'operationId', 'terminalId', 'token']) {
      expect(schema.safeParse({ kind: 'current', requesters: [requester], [privateField]: 'private' }).success).toBe(false);
      expect(schema.safeParse({ kind: 'current', requesters: [{ ...requester, [privateField]: 'private' }] }).success).toBe(false);
    }
  });

  it('refuses invalid counts without coercion or truncation and retains the complete requester audience', () => {
    const schema = MachineWorkSummaryV1Schema;
    for (const sessions of [-1, 0.5, '1', null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(schema.safeParse({ kind: 'current', requesters: [{ ...requester, sessions }] }).success).toBe(false);
    }
    const requesters = Array.from({ length: 300 }, (_, index) => ({
      ...requester, accountId: `requester-${index}`, tasks: 10_000,
    }));
    expect(schema.safeParse({ kind: 'current', requesters })).toMatchObject({
      success: true, data: { kind: 'current', requesters },
    });
  });
});
