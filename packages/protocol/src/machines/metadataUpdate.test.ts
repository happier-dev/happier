import { describe, expect, it } from 'vitest';
import { MachineUpdateMetadataRequestSchema } from './metadataUpdate.js';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from './machineStoredContent.js';

describe('Machine encoded metadata write admission', () => {
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
