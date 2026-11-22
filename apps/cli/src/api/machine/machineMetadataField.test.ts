import { mutateMachineAdminAccessV1 } from '@happier-dev/protocol/machines/adminAccessV1';
import tweetnacl from 'tweetnacl';
import { describe, expect, it, vi } from 'vitest';

import { MachineMetadataSchema, type Machine } from '../types';
import { createMachineMetadataFieldPort } from './machineMetadataField';
import { createMachineContentCodec } from './machineStoredContent';

const adminAccess = { version: 1, mode: 'ask', administratorUsername: 'operator' } as const;

function retainedMachine(): Machine {
  const encryptionKey = new Uint8Array(32).fill(19);
  return { id: 'worker', encryptionKey, encryptionVariant: 'legacy', metadataVersion: 34,
    daemonState: null, daemonStateVersion: 0, metadata: MachineMetadataSchema.parse({
      host: 'worker', platform: 'linux', homeDir: '/home/worker', happyHomeDir: '/home/worker/.happier',
      happyCliVersion: 'test', installationPublicKey: Buffer.from(tweetnacl.sign.keyPair.fromSeed(encryptionKey).publicKey).toString('base64url'),
      // READY196 retained a saved preset from before explicit preset encryption mode.
      setup: { version: 1, revision: 2, exclusions: [], sources: [
        { kind: 'direct', setup: {} },
        { kind: 'accountPreset', presetId: 'saved-preset', presetRevision: 1, setup: {} },
      ] },
    }) };
}

describe('Machine metadata field publication', () => {
  it('preserves a retained Setup source when an admin-access edit rebases on a newer Home revision', async () => {
    const machine = retainedMachine();
    const codec = createMachineContentCodec(machine);
    const newerMetadata = { ...machine.metadata!, host: 'renamed-worker' };
    const writes: Array<{ version: number; metadata: unknown }> = [];
    const port = createMachineMetadataFieldPort({ machineId: machine.id, readMachine: async () => machine,
      updateMetadata: async request => {
        writes.push({ version: request.expectedVersion, metadata: codec.decodeStored(request.metadata) });
        return request.expectedVersion === 34
          ? { result: 'version-mismatch', version: 35, metadata: codec.encodeStored(newerMetadata) }
          : { result: 'success', version: 36, metadata: request.metadata };
      },
    });
    await expect(mutateMachineAdminAccessV1({ comparison: 'field', expectedMetadataVersion: 34,
      expectedAdminAccess: { version: 1, mode: 'none' }, adminAccess }, port))
      .resolves.toMatchObject({ status: 'applied', policy: adminAccess, metadataVersion: 36 });
    expect(writes).toEqual([
      { version: 34, metadata: { ...machine.metadata, adminAccess } },
      { version: 35, metadata: { ...newerMetadata, adminAccess } },
    ]);
  });

  it('refuses a malformed replacement installation key even if the caller edits its read snapshot', async () => {
    const machine = retainedMachine();
    const updateMetadata = vi.fn(async () => ({ result: 'error' as const }));
    const port = createMachineMetadataFieldPort({ machineId: machine.id, readMachine: async () => machine, updateMetadata });
    const snapshot = await port.read();
    if (snapshot.status !== 'ready') throw new Error(`Expected ready metadata, got ${snapshot.status}`);
    snapshot.metadata.installationPublicKey = 'bad-key';
    await expect(port.compareAndSwap({ metadata: snapshot.metadata, expectedMetadataVersion: snapshot.metadataVersion }))
      .rejects.toMatchObject({ retryable: false });
    expect(updateMetadata).not.toHaveBeenCalled();
  });
});
