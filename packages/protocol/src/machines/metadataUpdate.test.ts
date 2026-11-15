import { describe, expect, it } from 'vitest';
import { MachineUpdateMetadataRequestSchema, readMachineIsolationV1 } from './metadataUpdate.js';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from './machineStoredContent.js';

describe('Machine encoded metadata write admission', () => {
  it('requires a valid created-environment fact before identifying a Machine as isolated', () => {
    const fact = { environment: 'managed-guest', provisionerId: 'acme.compute/vm' };
    expect(readMachineIsolationV1({ isolationV1: fact })).toEqual(fact);
    for (const metadata of [undefined, null, {}, { isolationV1: null },
      { isolationV1: { ...fact, environment: 'host' } }, { isolationV1: { ...fact, provisionerId: 'invalid' } }]) {
      expect(readMachineIsolationV1(metadata)).toBeNull();
    }
  });
  it('requires the published envelope identity even when the content revision is current', () => {
    const update = { machineId: 'machine-a', metadata: 'opaque-ciphertext', expectedVersion: 7 };
    expect(MachineUpdateMetadataRequestSchema.safeParse(update).success).toBe(false);
    expect(MachineUpdateMetadataRequestSchema.parse({ ...update, expectedDataEncryptionKey: null }))
      .toEqual({ ...update, expectedDataEncryptionKey: null });
    const plain = {
      ...update,
      metadata: encodePlainMachineStoredContent({ displayName: 'Office' }),
      expectedDataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
    };
    expect(MachineUpdateMetadataRequestSchema.parse(plain)).toEqual(plain);
  });
});
