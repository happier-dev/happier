import { describe, expect, it } from 'vitest';
import { MachineAccessGrantSetInputV1Schema, MachineAccessGrantStoredReadV1Schema, MachineAccessLossCustodyRequestV1Schema, MachineAccessLossCustodyResponseV1Schema } from './machineAccessV1.js';

describe('Machine access V1 admission boundaries', () => {
  it('accepts only a cleanup subject and actual settled or incomplete custody results', () => {
    expect(MachineAccessLossCustodyRequestV1Schema.parse({ v: 1, subjectAccountId: 'bob' }))
      .toEqual({ v: 1, subjectAccountId: 'bob' });
    for (const extra of [{ actorAccountId: 'alice' }, { serverId: 'another-home' }, { installationId: 'replacement' }]) {
      expect(MachineAccessLossCustodyRequestV1Schema.safeParse({ v: 1, subjectAccountId: 'bob', ...extra }).success).toBe(false);
    }
    expect(MachineAccessLossCustodyResponseV1Schema.safeParse({ kind: 'settled' }).success).toBe(true);
    expect(MachineAccessLossCustodyResponseV1Schema.safeParse({ kind: 'incomplete' }).success).toBe(true);
    expect(MachineAccessLossCustodyResponseV1Schema.safeParse({ kind: 'requested' }).success).toBe(false);
    expect(MachineAccessLossCustodyResponseV1Schema.safeParse({ kind: 'settled', subjectAccountId: 'bob' }).success).toBe(false);
  });
  const input = { serverId: 'home', machineId: 'machine', principal: { kind: 'account', accountId: 'recipient' }, level: 'view' };
  it('rejects unsupported Edit and author supplied actor/key proof recursively', () => {
    expect(MachineAccessGrantSetInputV1Schema.safeParse(input).success).toBe(true);
    for (const value of [
      { ...input, level: 'edit' },
      { ...input, actorAccountId: 'owner' },
      { ...input, recipientKeyEnvelopes: [] },
      { ...input, principal: { ...input.principal, custodianAccountId: 'owner' } },
    ]) expect(MachineAccessGrantSetInputV1Schema.safeParse(value).success).toBe(false);
  });
  it('drops additive stored grant fields while preserving the known authority', () => {
    expect(MachineAccessGrantStoredReadV1Schema.parse({ machineId: 'machine', principal: { kind: 'account', accountId: 'recipient', extra: true }, level: 'admin', extra: true }))
      .toEqual({ machineId: 'machine', principal: { kind: 'account', accountId: 'recipient' }, level: 'admin' });
  });
});
