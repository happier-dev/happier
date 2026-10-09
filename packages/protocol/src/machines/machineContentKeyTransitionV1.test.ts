import { describe, expect, it } from 'vitest';
import { deriveBoxPublicKeyFromSeed } from '../crypto/boxBundle.js';
import { sealEncryptedDataKeyEnvelopeV1 } from '../crypto/encryptedDataKeyEnvelopeV1.js';
import { encodeBase64 } from '../crypto/base64.js';
import { MachineContentKeyTransitionInputV1Schema, MachineContentKeyTransitionResultV1Schema } from './machineContentKeyTransitionV1.js';

describe('Machine whole-content transition seam', () => {
  it('projects stored row additions but closes transition authority and preserves null state', () => {
    const envelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({
      dataKey: new Uint8Array(32).fill(7), recipientPublicKey: deriveBoxPublicKeyFromSeed(new Uint8Array(32).fill(11)),
      randomBytes: (length) => new Uint8Array(length).fill(13),
    }));
    const expected = { dataEncryptionKey: null, metadataVersion: 3, daemonStateVersion: 5 };
    const input = { machineId: 'machine', expected, next: { dataEncryptionKey: envelope, metadata: 'opaque', daemonState: null } };
    expect(MachineContentKeyTransitionInputV1Schema.parse(input)).toEqual(input);
    expect(MachineContentKeyTransitionInputV1Schema.safeParse({ ...input, expected: { ...expected, owner: 'foreign' } }).success).toBe(false);
    expect(MachineContentKeyTransitionInputV1Schema.safeParse({ ...input, next: { ...input.next, dataEncryptionKey: envelope.slice(0, -1) } }).success).toBe(false);
    const machine = { id: 'machine', kind: 'persistent' as const, metadata: 'opaque', metadataVersion: 4, daemonState: null, daemonStateVersion: 6,
      dataEncryptionKey: envelope, keyBasis: { dataEncryptionKey: envelope, metadataVersion: 4, daemonStateVersion: 6 } };
    expect(MachineContentKeyTransitionResultV1Schema.parse({ kind: 'committed', machine: { ...machine, future: true } }))
      .toEqual({ kind: 'committed', machine });
    expect(MachineContentKeyTransitionResultV1Schema.safeParse({ kind: 'committed', machine, authority: 'foreign' }).success).toBe(false);
  });
});
