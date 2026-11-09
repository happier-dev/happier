import { describe, expect, it } from 'vitest';

import { UpdateBodySchema } from './index.js';

describe('AccountChange update bodies', () => {
  it('preserves exact content-free Session record targets and an explicit unchanged record set', () => {
    for (const sessionSystemRecords of [[], [{ sessionId: 'session-1', address: {
      owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'visual',
    } }], [{ sessionId: 'session-1' }]]) {
      const body = { t: 'account-change', changeKinds: ['session'], entityIds: ['session-1'], sessionSystemRecords };
      expect(UpdateBodySchema.parse(body)).toEqual(body);
    }
    expect(UpdateBodySchema.safeParse({ t: 'account-change', sessionSystemRecords: [{ sessionId: 'session-1', content: 'private' }] }).success).toBe(false);
  });
  it('preserves optional committed routing facts, including future kinds for coarse readers', () => {
    for (const changeKinds of [['session', 'machine'], ['machineRecipientAccess'], [], ['future-kind']]) {
      const body = { t: 'account-change', changeKinds, entityIds: ['session-1', 'machine-1'] };
      expect(UpdateBodySchema.parse(body)).toEqual(body);
    }
    expect(UpdateBodySchema.safeParse({ t: 'account-change', changeKinds: [1] }).success).toBe(false);
    expect(UpdateBodySchema.safeParse({ t: 'account-change', entityIds: [1] }).success).toBe(false);
  });

  it('accepts only the content-free AccountChange wake arm', () => {
    expect(UpdateBodySchema.safeParse({ t: 'account-change' }).success).toBe(true);
    expect(UpdateBodySchema.safeParse({
      t: 'account-change',
      pluginId: 'example.tasks',
    }).success).toBe(false);
  });
});
