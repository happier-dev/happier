import { describe, it, expect } from 'vitest';
import { encodeBase64 } from '@/encryption/base64';
import { Encryption } from './encryption';

describe('Encryption.initializeMachines (key updates)', () => {
  it('updates machine encryption when a data key becomes available later', async () => {
    const masterSecret = new Uint8Array(32).fill(1);
    const machineDataKey = new Uint8Array(32).fill(2);
    const machineId = 'machine_1';

    const encryption = await Encryption.create(masterSecret);

    // First initialize without a data key (fallback encryption).
    await encryption.initializeMachines(new Map([[machineId, null]]));
    const before = encryption.getMachineEncryption(machineId);
    expect(before).toBeTruthy();

    // Encrypt a payload using the machine data key (AES mode).
    const aes = await encryption.openEncryption(machineDataKey);
    const payload = { hello: 'world' };
    const encrypted = await aes.encrypt([payload]);
    const ciphertextB64 = encodeBase64(encrypted[0], 'base64');

    // With fallback encryption, decrypting AES ciphertext must fail.
    expect(await before!.decryptRaw(ciphertextB64)).toBeNull();

    // Later, the data key becomes available (e.g. after decryptEncryptionKey succeeds).
    await encryption.initializeMachines(new Map([[machineId, machineDataKey]]));
    const after = encryption.getMachineEncryption(machineId);
    expect(after).toBeTruthy();

    // After re-initialization, decryption should succeed.
    expect(await after!.decryptRaw(ciphertextB64)).toEqual(payload);
  });
});
