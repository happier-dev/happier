import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { encodeBase64 } from '../crypto/base64.js';
import { MachineAvailabilityDiagnosticV1Schema, MachineAccessGrantSetInputV1Schema, MachineAccessGrantStoredReadV1Schema, MachineAccessLossCustodyRequestV1Schema, MachineAccessLossCustodyResponseV1Schema, MachineAdmissionVerifyResponseV1Schema } from './machineAccessV1.js';

describe('Machine access V1 admission boundaries', () => {
  it('carries the setup Manage refusal and its matching recovery without admitting authored authority', () => {
    const diagnostic = { reason: 'machine_setup_requires_manage', requiredFact: 'machine_manage_role',
      remedy: 'request_machine_manage_access' };
    expect(MachineAvailabilityDiagnosticV1Schema.parse(diagnostic)).toEqual(diagnostic);
    expect(MachineAvailabilityDiagnosticV1Schema.safeParse({ ...diagnostic, role: 'manage' }).success).toBe(false);
    expect(MachineAvailabilityDiagnosticV1Schema.safeParse({ ...diagnostic, remedy: 'reconnect_machine' }).success).toBe(false);
  });
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
  it('preserves the independently admitted receiving tuple and role in the admission response', () => {
    const receivingMachineAdmission = { actorAccountId: 'original-requester', custodianAccountId: 'physical-owner',
      machineId: 'receiving-machine', installationId: 'receiving-installation', role: 'manage', encryptionMode: 'plain' };
    for (const role of ['manage', 'use']) {
      const response = { v: 1, ok: true, receivingMachineAdmission: { ...receivingMachineAdmission, role } };
      expect(MachineAdmissionVerifyResponseV1Schema.parse(response)).toEqual(response);
    }
    expect(MachineAdmissionVerifyResponseV1Schema.parse({ v: 1, ok: true })).toEqual({ v: 1, ok: true });
    for (const admission of [
      { ...receivingMachineAdmission, actorAccountId: '' },
      { ...receivingMachineAdmission, machineId: '' },
      { ...receivingMachineAdmission, installationId: '' },
      { ...receivingMachineAdmission, role: 'owner' },
      { ...receivingMachineAdmission, authority: 'present_user' },
    ]) expect(MachineAdmissionVerifyResponseV1Schema.safeParse({ v: 1, ok: true, receivingMachineAdmission: admission }).success).toBe(false);
  });
  it('accepts only a cleanup subject and actual settled or incomplete custody results', () => {
    expect(MachineAccessLossCustodyRequestV1Schema.parse({ v: 1, subjectAccountId: 'bob' }))
      .toEqual({ v: 1, subjectAccountId: 'bob' });
    expect(MachineAccessLossCustodyRequestV1Schema.parse({ v: 1, subjectAccountId: 'bob', remainingRole: 'use' }))
      .toEqual({ v: 1, subjectAccountId: 'bob', remainingRole: 'use' });
    expect(MachineAccessLossCustodyRequestV1Schema.safeParse({ v: 1, subjectAccountId: 'bob', remainingRole: 'manage' }).success).toBe(false);
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
