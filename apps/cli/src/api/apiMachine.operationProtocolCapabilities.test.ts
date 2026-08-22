import { describe, expect, it, vi } from 'vitest';

import type { Machine } from '@/api/types';

import { ApiMachineClient } from './apiMachine';

function createMachine(): Machine {
  return {
    id: 'machine-1',
    encryptionKey: new Uint8Array(32).fill(1),
    encryptionVariant: 'legacy',
    metadata: null,
    metadataVersion: 0,
    daemonState: null,
    daemonStateVersion: 0,
  };
}

describe('ApiMachineClient operation protocol capability publication', () => {
  it('sends the complete strict projection through the authenticated Machine mutation', async () => {
    const client = new ApiMachineClient('token', createMachine());
    const emitWithAck = vi.fn(async () => ({ v: 1, result: 'success', revision: 4 }));
    const socket = {
      connected: true,
      timeout: vi.fn(() => ({ emitWithAck })),
    };
    (client as unknown as { socket: unknown }).socket = socket;

    await expect(client.publishOperationProtocolCapabilities({
      sessionSpawn: { protocolVersions: [1] },
    })).resolves.toBe(4);

    expect(emitWithAck).toHaveBeenCalledWith(
      'machine-update-operation-protocol-capabilities',
      {
        machineId: 'machine-1',
        capabilities: {
          sessionSpawn: { protocolVersions: [1] },
        },
      },
    );
  });

  it('rejects an unrecognized capability response instead of treating it as support', async () => {
    const client = new ApiMachineClient('token', createMachine());
    const socket = {
      connected: true,
      timeout: vi.fn(() => ({
        emitWithAck: vi.fn(async () => ({ result: 'success', revision: 1 })),
      })),
    };
    (client as unknown as { socket: unknown }).socket = socket;

    await expect(client.publishOperationProtocolCapabilities({})).rejects.toThrow();
  });
});
