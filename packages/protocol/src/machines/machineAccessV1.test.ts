import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { encodeBase64 } from '../crypto/base64.js';
import { MachineAccessGrantSetInputV1Schema, MachineAccessGrantStoredReadV1Schema, MachineAccessLossCustodyRequestV1Schema, MachineAccessLossCustodyResponseV1Schema, MachineAdmissionVerifyResponseV1Schema } from './machineAccessV1.js';

describe('Machine access V1 admission boundaries', () => {
  it('preserves the exact destination installation in the existing admission response without adding a grant', () => {
    const key = tweetnacl.sign.keyPair();
    const destinationInstallation = { machineId: 'chosen-target', installationId: 'target-installation',
      installationPublicKey: encodeBase64(key.publicKey, 'base64url') };
    const response = { v: 1, ok: true, destinationInstallation };
    expect(MachineAdmissionVerifyResponseV1Schema.parse(response)).toEqual(response);
    expect(MachineAdmissionVerifyResponseV1Schema.parse({ v: 1, ok: true })).toEqual({ v: 1, ok: true });
    for (const destination of [
      { ...destinationInstallation, installationPublicKey: encodeBase64(new Uint8Array(31), 'base64url') },
      { ...destinationInstallation, installationPublicKey: 'not-a-key' },
      { ...destinationInstallation, actorAccountId: 'another-requester' },
      { ...destinationInstallation, role: 'manage' },
    ]) expect(MachineAdmissionVerifyResponseV1Schema.safeParse({ ...response, destinationInstallation: destination }).success).toBe(false);
  });
  it('accepts only a cleanup subject and actual settled or incomplete custody results', () => {
    expect(MachineAccessLossCustodyRequestV1Schema.parse({ v: 1, subjectAccountId: 'bob' }))
      .toEqual({ v: 1, subjectAccountId: 'bob' });
    expect(MachineAccessLossCustodyRequestV1Schema.parse({ v: 1, kind: 'requesters' }))
      .toEqual({ v: 1, kind: 'requesters' });
    expect(MachineAccessLossCustodyRequestV1Schema.safeParse({ v: 1, kind: 'requesters', subjectAccountId: 'bob' }).success).toBe(false);
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
